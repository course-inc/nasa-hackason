//! pi-rs agent harness for the desktop app (cargo feature "agent").
//!
//! The webview owns the tools (they run the Rust core through WASM and move the map). It sends
//! their specs with `agent_start`; the `WalkbackBridge` extension advertises them to the model and,
//! when the model calls one, emits `agent-tool-call` to the webview and waits (60 s) for
//! `agent_tool_result`. Model text is forwarded as `agent-event`.
//!
//! Model: Anthropic when ANTHROPIC_API_KEY is set, otherwise a local Ollama server.
//! PI_RS_MODEL overrides the model name.

use std::collections::HashMap;
use std::net::{SocketAddr, TcpStream};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use pi_rs::{
    AgentSession, Extension, Model, Outcome, SessionBuilder, SessionControl, SessionEvent, Tool,
    ToolContext, ToolSpec,
};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{oneshot, Mutex};

pub const SYSTEM_PROMPT: &str = "あなたは火星の船外活動計画の相棒。数字は必ずツールの結果だけを使い、自分で計算・推測しない。答えには出典（ツールの sources）を添える。表示ツールで地図を動かして見せる。ユーザーの言語で答える。";
const ANTHROPIC_URL: &str = "https://api.anthropic.com/v1/messages";
const OLLAMA_URL: &str = "http://127.0.0.1:11434/v1/chat/completions";
const OLLAMA_DEFAULT: &str = "qwen2.5:7b";
const TOOL_TIMEOUT: Duration = Duration::from_secs(60);

pub struct ToolReply {
    pub ok: bool,
    pub output: String,
    pub details: Value,
}

type Pending = Arc<StdMutex<HashMap<String, oneshot::Sender<ToolReply>>>>;
/// Sends an event to the webview (`app.emit` in the app, a closure in tests).
pub type Emit = Arc<dyn Fn(&str, Value) -> Result<(), String> + Send + Sync>;

/// One webview tool, called over the event bridge.
struct BridgeTool {
    spec: ToolSpec,
    emit: Emit,
    pending: Pending,
}

#[async_trait::async_trait]
impl Tool for BridgeTool {
    fn spec(&self) -> ToolSpec {
        self.spec.clone()
    }

    fn use_default_timeout(&self) -> bool {
        false // our own 60 s wait below; explore_hokkaido loads duckdb on its first call
    }

    async fn invoke(&self, arguments: Value, context: ToolContext) -> Outcome {
        let id = context.operation_id.to_string();
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id.clone(), tx);
        let call = json!({ "id": id, "name": self.spec.name, "args": arguments });
        if let Err(e) = (self.emit)("agent-tool-call", call) {
            self.pending.lock().unwrap().remove(&id);
            return Outcome::Failed(format!("could not reach the app: {e}"));
        }
        let reply = tokio::select! {
            r = tokio::time::timeout(TOOL_TIMEOUT, rx) => r,
            _ = context.cancellation.cancelled() => {
                self.pending.lock().unwrap().remove(&id);
                return Outcome::Failed("cancelled".into());
            }
        };
        match reply {
            Ok(Ok(r)) if r.ok => Outcome::SucceededWithDetails {
                output: r.output,
                details: r.details,
            },
            Ok(Ok(r)) => Outcome::Failed(r.output),
            _ => {
                self.pending.lock().unwrap().remove(&id);
                Outcome::Failed(format!(
                    "{} did not answer within {} s",
                    self.spec.name,
                    TOOL_TIMEOUT.as_secs()
                ))
            }
        }
    }
}

/// Extension exposing the webview's tools to the model.
pub struct WalkbackBridge {
    tools: Vec<Arc<dyn Tool>>,
}

impl WalkbackBridge {
    fn new(specs: &[ToolSpec], emit: Emit, pending: Pending) -> Self {
        let tools = specs
            .iter()
            .map(|s| {
                Arc::new(BridgeTool {
                    spec: s.clone(),
                    emit: emit.clone(),
                    pending: pending.clone(),
                }) as Arc<dyn Tool>
            })
            .collect();
        Self { tools }
    }
}

impl Extension for WalkbackBridge {
    fn id(&self) -> &str {
        "walkback-bridge"
    }
    fn tools(&self) -> Vec<Arc<dyn Tool>> {
        self.tools.clone()
    }
}

#[derive(Clone, Serialize)]
pub struct ModelInfo {
    pub provider: &'static str,
    pub model: String,
}

/// Anthropic with ANTHROPIC_API_KEY, else Ollama if its port answers, else an error to show.
fn pick_model() -> Result<(Arc<dyn Model>, ModelInfo), String> {
    let name = std::env::var("PI_RS_MODEL")
        .ok()
        .filter(|s| !s.trim().is_empty());
    if let Some(key) = std::env::var("ANTHROPIC_API_KEY")
        .ok()
        .filter(|s| !s.trim().is_empty())
    {
        let m = pi_rs::anthropic::Anthropic::new(ANTHROPIC_URL, &key).map_err(|e| e.to_string())?;
        return Ok((
            Arc::new(m),
            ModelInfo {
                provider: "anthropic",
                model: name.unwrap_or_else(|| "claude-sonnet-4-5".into()),
            },
        ));
    }
    if let Some(installed) = ollama_models() {
        // PI_RS_MODEL, else qwen2.5:7b if pulled, else the first installed model that can call tools.
        let model = name
            .or_else(|| {
                installed
                    .iter()
                    .find(|m| m.0 == OLLAMA_DEFAULT)
                    .map(|m| m.0.clone())
            })
            .or_else(|| installed.iter().find(|m| m.1).map(|m| m.0.clone()))
            .ok_or_else(|| {
                format!("Ollama has no model that can call tools: ollama pull {OLLAMA_DEFAULT}")
            })?;
        let m = pi_rs::ollama::Ollama::new(OLLAMA_URL, None).map_err(|e| e.to_string())?;
        return Ok((
            Arc::new(m),
            ModelInfo {
                provider: "ollama",
                model,
            },
        ));
    }
    Err(
        format!("no model: set ANTHROPIC_API_KEY, or start Ollama (ollama serve; ollama pull {OLLAMA_DEFAULT})"),
    )
}

/// Installed Ollama models as (name, can call tools), or None when no server answers.
fn ollama_models() -> Option<Vec<(String, bool)>> {
    use std::io::{Read, Write};
    let addr: SocketAddr = "127.0.0.1:11434".parse().unwrap();
    let mut s = TcpStream::connect_timeout(&addr, Duration::from_millis(400)).ok()?;
    s.set_read_timeout(Some(Duration::from_secs(3))).ok()?;
    s.write_all(b"GET /api/tags HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n")
        .ok()?;
    let mut body = String::new();
    s.read_to_string(&mut body).ok()?;
    let json: Value = serde_json::from_str(body.split("\r\n\r\n").nth(1)?).ok()?;
    Some(
        json["models"]
            .as_array()?
            .iter()
            .filter_map(|m| {
                let tools = m["capabilities"]
                    .as_array()
                    .is_none_or(|c| c.iter().any(|x| x == "tools"));
                Some((m["name"].as_str()?.to_string(), tools))
            })
            .collect(),
    )
}

struct Live {
    session: Arc<Mutex<AgentSession>>,
    control: SessionControl,
    specs: Vec<ToolSpec>,
    info: ModelInfo,
}

#[derive(Default)]
pub struct AgentState {
    live: StdMutex<Option<Live>>,
    pending: Pending,
}

impl AgentState {
    /// Start (or reuse, when the tools are unchanged) a session over `specs`.
    pub fn start(
        &self,
        specs: Vec<ToolSpec>,
        model: Arc<dyn Model>,
        info: ModelInfo,
        emit: Emit,
    ) -> Result<ModelInfo, String> {
        let mut live = self.live.lock().unwrap();
        if let Some(l) = live.as_ref() {
            if l.specs == specs && l.info.model == info.model && l.info.provider == info.provider {
                return Ok(l.info.clone());
            }
        }
        let bridge = WalkbackBridge::new(&specs, emit.clone(), self.pending.clone());
        let session = SessionBuilder::new(model, info.model.clone())
            .system_prompt(SYSTEM_PROMPT)
            .extension(Arc::new(bridge))
            .and_then(|b| b.in_memory())
            .map_err(|e| e.to_string())?;
        let control = session.controls();
        let mut rx = session.subscribe();
        tauri::async_runtime::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(SessionEvent::Text(t)) => {
                        let _ = emit("agent-event", json!({ "type": "text", "text": t }));
                    }
                    Ok(SessionEvent::RunFailed { message, .. }) => {
                        let _ = emit(
                            "agent-event",
                            json!({ "type": "error", "message": message }),
                        );
                    }
                    Ok(SessionEvent::Closed)
                    | Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    Ok(_) | Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                }
            }
        });
        *live = Some(Live {
            session: Arc::new(Mutex::new(session)),
            control,
            specs,
            info: info.clone(),
        });
        Ok(info)
    }

    pub async fn prompt(&self, text: String) -> Result<String, String> {
        let session = self
            .live
            .lock()
            .unwrap()
            .as_ref()
            .map(|l| l.session.clone())
            .ok_or("agent not started")?;
        let mut s = session.lock().await;
        s.prompt(text).await.map_err(|e| e.to_string())
    }

    pub fn tool_result(&self, id: &str, reply: ToolReply) -> bool {
        match self.pending.lock().unwrap().remove(id) {
            Some(tx) => tx.send(reply).is_ok(),
            None => false,
        }
    }

    pub fn abort(&self) {
        if let Some(l) = self.live.lock().unwrap().as_ref() {
            l.control.abort();
        }
    }
}

#[tauri::command]
pub fn agent_start(
    app: AppHandle,
    state: State<'_, AgentState>,
    tools: Vec<ToolSpec>,
) -> Result<ModelInfo, String> {
    let (model, info) = pick_model()?;
    let emit: Emit = Arc::new(move |event: &str, payload: Value| {
        app.emit(event, payload).map_err(|e| e.to_string())
    });
    state.start(tools, model, info, emit)
}

#[tauri::command]
pub async fn agent_prompt(state: State<'_, AgentState>, text: String) -> Result<String, String> {
    state.prompt(text).await
}

#[tauri::command]
pub fn agent_tool_result(
    state: State<'_, AgentState>,
    id: String,
    ok: bool,
    output: String,
    details: Option<Value>,
) -> bool {
    state.tool_result(
        &id,
        ToolReply {
            ok,
            output,
            details: details.unwrap_or(Value::Null),
        },
    )
}

#[tauri::command]
pub fn agent_abort(state: State<'_, AgentState>) {
    state.abort();
}

#[cfg(test)]
mod tests {
    use super::*;
    use pi_rs::{ModelEvent, ModelRequest, ModelStream, ToolCall};
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Calls walkback_check once, then answers with the tool's text.
    struct Fixture(AtomicUsize);
    #[async_trait::async_trait]
    impl Model for Fixture {
        async fn stream(&self, req: ModelRequest) -> pi_rs::Result<ModelStream> {
            let n = self.0.fetch_add(1, Ordering::SeqCst);
            assert!(
                req.tools.iter().any(|t| t.name == "walkback_check"),
                "bridge tool advertised"
            );
            let events = if n == 0 {
                vec![Ok(ModelEvent::Complete {
                    calls: vec![ToolCall {
                        id: "t1".into(),
                        name: "walkback_check".into(),
                        arguments: r#"{"route":"example"}"#.into(),
                    }],
                    usage: None,
                })]
            } else {
                let last = format!("{:?}", req.messages.last());
                assert!(
                    last.contains("帰れる"),
                    "tool output reaches the model: {last}"
                );
                vec![
                    Ok(ModelEvent::Text("帰れます".into())),
                    Ok(ModelEvent::Complete {
                        calls: vec![],
                        usage: None,
                    }),
                ]
            };
            Ok(Box::pin(futures_util::stream::iter(events)))
        }
    }

    #[tokio::test]
    async fn bridge_round_trip() {
        let state = Arc::new(AgentState::default());
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<(String, Value)>();
        let emit: Emit =
            Arc::new(move |e: &str, v: Value| tx.send((e.into(), v)).map_err(|e| e.to_string()));
        let specs = vec![ToolSpec {
            name: "walkback_check".into(),
            description: "check".into(),
            parameters: json!({"type":"object"}),
        }];
        state
            .start(
                specs,
                Arc::new(Fixture(AtomicUsize::new(0))),
                ModelInfo {
                    provider: "fixture",
                    model: "fixture".into(),
                },
                emit,
            )
            .unwrap();
        // Play the webview: answer every tool call.
        let st = state.clone();
        tokio::spawn(async move {
            while let Some((event, v)) = rx.recv().await {
                if event == "agent-tool-call" {
                    assert_eq!(v["name"], "walkback_check");
                    assert_eq!(v["args"]["route"], "example");
                    st.tool_result(
                        v["id"].as_str().unwrap(),
                        ToolReply {
                            ok: true,
                            output: "判定: 帰れる。".into(),
                            details: json!({"ok": true}),
                        },
                    );
                }
            }
        });
        let answer = state.prompt("帰れる？".into()).await.unwrap();
        assert_eq!(answer, "帰れます");
    }

    /// Real model (ANTHROPIC_API_KEY or local Ollama): it must call walkback_check and quote it.
    ///   cargo test -p analog-finder --lib -- --ignored --nocapture
    #[tokio::test(flavor = "multi_thread")]
    #[ignore]
    async fn real_model_calls_the_tool() {
        let (model, info) = pick_model().expect("a model");
        println!("model: {} / {}", info.provider, info.model);
        let state = Arc::new(AgentState::default());
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<(String, Value)>();
        let emit: Emit =
            Arc::new(move |e: &str, v: Value| tx.send((e.into(), v)).map_err(|e| e.to_string()));
        let specs = vec![ToolSpec {
            name: "walkback_check".into(),
            description: "Check whether the astronaut can walk back to the base on Mars. Returns the verdict and distances.".into(),
            parameters: json!({"type":"object","properties":{"route":{"type":"object","properties":{"away_km":{"type":"number"}}}}}),
        }];
        state.start(specs, model, info, emit).unwrap();
        let st = state.clone();
        let called = Arc::new(AtomicUsize::new(0));
        let c2 = called.clone();
        tokio::spawn(async move {
            while let Some((event, v)) = rx.recv().await {
                if event == "agent-tool-call" {
                    println!("tool call: {v}");
                    c2.fetch_add(1, Ordering::SeqCst);
                    st.tool_result(v["id"].as_str().unwrap(), ToolReply {
                        ok: true,
                        output: "判定: 帰れる。行き 6.1 km / 帰り（まっすぐ）3.0 km、かかる時間 4:36。".into(),
                        details: Value::Null,
                    });
                }
            }
        });
        let answer = state
            .prompt("基地から3km先まで歩いて帰れる？".into())
            .await
            .unwrap();
        println!("answer: {answer}");
        assert!(called.load(Ordering::SeqCst) >= 1, "model called the tool");
        assert!(answer.contains("6.1"), "answer quotes the tool");
    }
}
