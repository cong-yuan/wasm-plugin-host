// hello-go — example Go plugin implementing ABI v1.
//
// Build:
//   GOOS=wasip1 GOARCH=wasm go build -buildmode=c-shared -o hello_go.wasm .
package main

import (
	"encoding/json"
	"unsafe"
)

// ---------------- host imports ----------------

//go:wasmimport host log
func hostLog(level int32, ptr uint32, length int32)

func logStr(level int32, s string) {
	if len(s) == 0 {
		return
	}
	hostLog(level, uint32(uintptr(unsafe.Pointer(unsafe.StringData(s)))), int32(len(s)))
}

// ---------------- allocator ----------------
//
// Keep each allocation alive in a map so the (non-moving) Go GC does not
// reclaim it while the host holds the pointer. plugin_free drops it.

var live = map[uint32][]byte{}

//go:wasmexport plugin_alloc
func pluginAlloc(size int32) int32 {
	if size <= 0 {
		size = 1
	}
	buf := make([]byte, size)
	p := uint32(uintptr(unsafe.Pointer(unsafe.SliceData(buf))))
	live[p] = buf
	return int32(p)
}

//go:wasmexport plugin_free
func pluginFree(ptr int32, size int32) {
	delete(live, uint32(ptr))
}

// ---------------- ABI v1 ----------------

//go:wasmexport plugin_abi_version
func pluginAbiVersion() int32 { return 1 }

//go:wasmexport plugin_init
func pluginInit() int32 {
	logStr(1, "hello-go: init")
	return 0
}

//go:wasmexport plugin_shutdown
func pluginShutdown() {
	logStr(1, "hello-go: shutdown")
}

//go:wasmexport plugin_describe
func pluginDescribe(out int32, cap int32) int64 {
	decl := map[string]any{
		"name": "hello-go",
		"abi":  1,
		"tools": []map[string]any{
			{
				"name":        "go_greet",
				"description": "Greet from the Go plugin",
				"parameters": map[string]any{
					"type":       "object",
					"properties": map[string]any{"who": map[string]any{"type": "string"}},
				},
				"exec": "go_greet",
			},
			{
				"name":        "go_upper",
				"description": "Uppercase a string (Go stdlib)",
				"parameters": map[string]any{
					"type":       "object",
					"properties": map[string]any{"text": map[string]any{"type": "string"}},
				},
				"exec": "go_upper",
			},
		},
	}
	b, _ := json.Marshal(decl)
	return writeOut(out, cap, b)
}

//go:wasmexport plugin_invoke
func pluginInvoke(opPtr, opLen, argsPtr, argsLen, out, cap int32) int64 {
	op := readStr(opPtr, opLen)
	args := readStr(argsPtr, argsLen)

	var res map[string]any
	switch op {
	case "go_greet":
		var a struct {
			Who string `json:"who"`
		}
		_ = json.Unmarshal([]byte(args), &a)
		if a.Who == "" {
			a.Who = "world"
		}
		logStr(1, "go_greet called for "+a.Who)
		res = map[string]any{
			"kind":    "success",
			"content": "Go says hello, " + a.Who + "!",
			"value":   map[string]any{"who": a.Who},
		}
	case "go_upper":
		var a struct {
			Text string `json:"text"`
		}
		_ = json.Unmarshal([]byte(args), &a)
		up := toUpper(a.Text)
		res = map[string]any{
			"kind":    "success",
			"content": up,
			"value":   map[string]any{"text": a.Text, "upper": up},
		}
	default:
		res = map[string]any{"kind": "error", "message": "unknown op " + op, "code": "NO_OP"}
	}
	b, _ := json.Marshal(res)
	return writeOut(out, cap, b)
}

// ---------------- helpers ----------------

func readStr(ptr, length int32) string {
	if ptr == 0 || length <= 0 {
		return ""
	}
	b := unsafe.Slice((*byte)(unsafe.Pointer(uintptr(ptr))), length)
	return string(b)
}

func writeOut(out, cap int32, data []byte) int64 {
	if out == 0 || len(data) > int(cap) {
		return -int64(len(data))
	}
	dst := unsafe.Slice((*byte)(unsafe.Pointer(uintptr(out))), len(data))
	copy(dst, data)
	return int64(len(data))
}

// toUpper avoids importing strings just to show stdlib is available anyway.
func toUpper(s string) string {
	b := []rune(s)
	for i, r := range b {
		if r >= 'a' && r <= 'z' {
			b[i] = r - 32
		}
	}
	return string(b)
}

func main() {}
