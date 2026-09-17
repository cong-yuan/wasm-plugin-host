//! wasm-plugin-host — a dsh-style WASM plugin host.
//!
//! Library surface for embedding: [`Registry`] (slots + atomic reload),
//! [`Runtime`] (compile/cache/instantiate), [`Supervisor`] (config-driven
//! desired state + file watching), and [`config::Config`].

pub mod config;
pub mod flow;
pub mod hooks;
pub mod pipe;
pub mod plugin;
pub mod registry;
pub mod runtime;
pub mod service;
pub mod state;
pub mod supervisor;

pub use flow::{run_turn, Model, ScriptedModel, TurnOutcome};
pub use hooks::{Decision, Dispatch, Event as FlowEvent, Hooks};
pub use pipe::{log_pipes, Channel, LogPipe};
pub use plugin::{
    HookDecl, HookMode, Plugin, PluginDecl, PluginState, SlotDecl, SlotInject, ToolDecl, UiDecl,
    WindowContent, WindowDecl, WindowOpen,
};
pub use registry::{LoadedReport, Registry, ReloadReport};
pub use runtime::{AllocationStrategy, CacheStats, Runtime};
pub use service::{Convergence, Shared};
pub use state::{LogHook, LogLevel, LogRecord, LogSink};
pub use supervisor::{render, Event as SupervisorEvent, Supervisor, Watcher};
pub use config::{CacheConfig, Config, PluginEntry, ValidationIssue, Watch};
/// Back-compat: the supervisor's event type used to be exported as `Event`.
pub use supervisor::Event;
