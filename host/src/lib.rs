//! wasm-plugin-host — a dsh-style WASM plugin host.
//!
//! Library surface for embedding: [`Registry`] (slots + atomic reload),
//! [`Runtime`] (compile/cache/instantiate), [`Supervisor`] (config-driven
//! desired state + file watching), and [`config::Config`].

pub mod audit;
pub mod capability;
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

pub use audit::{AuditDecision, AuditEvent, AuditSink, DEFAULT_AUDIT_CAPACITY};
pub use capability::{
    AgentCapabilities, CapabilityGate, CapabilitySet, EffectiveCapabilities,
    FilesystemCapabilities, NetworkCapabilities, PluginPolicy, ResourceLimits, ServiceCapabilities,
    TrustMode, UiCapabilities, UiHostAction,
};
pub use config::{CacheConfig, Config, PluginEntry, ValidationIssue, Watch};
pub use flow::{run_turn, Model, ScriptedModel, TurnOutcome};
pub use hooks::{Decision, Dispatch, Event as FlowEvent, Hooks};
pub use pipe::{
    log_pipes, log_pipes_limited, log_pipes_with_budget, log_pipes_with_budget_and_audit, Channel,
    LogPipe,
};
pub use plugin::{
    AdjustAction, HookDecl, HookMode, Plugin, PluginDecl, PluginState, RouteDecl, SlotDecl,
    SlotInject, ToolDecl, UiAdjust, UiDecl, WindowContent, WindowDecl, WindowOpen,
};
pub use registry::{LoadedReport, Registry, ReloadReport};
pub use runtime::{AllocationStrategy, CacheStats, Runtime};
pub use service::{Convergence, Shared};
pub use state::{LogHook, LogLevel, LogRecord, LogSink};
/// Back-compat: the supervisor's event type used to be exported as `Event`.
pub use supervisor::Event;
pub use supervisor::{render, Event as SupervisorEvent, Supervisor, Watcher};
