from wit_world.exports import Lifecycle as LifecycleProtocol
from wit_world.imports import types


class Lifecycle(LifecycleProtocol):
    def abi_version(self) -> int:
        return 1

    def init(self) -> None:
        return None

    def configure(self, config_json: str) -> None:
        return None

    def describe(self) -> types.PluginDecl:
        return types.PluginDecl(
            name="component-python-demo",
            abi=1,
            tools=[
                types.ToolDecl(
                    name="python_component_echo",
                    description="Echo JSON through a Python WebAssembly Component",
                    parameters_json='{"type":"object"}',
                    exec="echo",
                    requires=[],
                )
            ],
            hooks=[],
            injects=[],
            provides=[],
            capabilities=types.CapabilityRequest(
                filesystem=types.FilesystemCapabilities(
                    read=[], write=[], create=[], delete=[]
                ),
                network=types.NetworkCapabilities(allow=[], methods=[]),
                agent=types.AgentCapabilities(observe=[], rewrite=[], veto=[]),
                services=types.ServiceCapabilities(consume=[], provide=[]),
                ui=types.UiCapabilities(
                    slots=[],
                    routes=[],
                    windows=False,
                    theme=False,
                    adjusts=[],
                    backend_commands=[],
                    host_events=[],
                ),
            ),
            ui=None,
        )

    def invoke(self, op: str, args_json: str) -> types.InvokeResult:
        if op == "echo":
            return types.InvokeResult_Success(
                types.InvokeSuccess(
                    content="python component echo",
                    value_json=args_json,
                )
            )
        return types.InvokeResult_Error(
            types.InvokeError(
                code="unknown_op",
                message="unknown op: " + op,
                value_json="null",
            )
        )

    def shutdown(self) -> None:
        return None
