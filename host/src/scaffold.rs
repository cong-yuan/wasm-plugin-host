//! Self-contained plugin project scaffolds.

use anyhow::{bail, Context, Result};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScaffoldKind {
    RustCore,
    RustComponent,
    JsComponent,
}

impl ScaffoldKind {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "rust-core" | "core" => Some(Self::RustCore),
            "rust-component" | "component" | "rust" => Some(Self::RustComponent),
            "js-component" | "js" | "javascript" => Some(Self::JsComponent),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::RustCore => "rust-core",
            Self::RustComponent => "rust-component",
            Self::JsComponent => "js-component",
        }
    }
}

#[derive(Debug, Clone)]
pub struct ScaffoldReport {
    pub path: PathBuf,
    pub name: String,
    pub kind: ScaffoldKind,
    pub files: Vec<PathBuf>,
}

struct TemplateFile {
    path: &'static str,
    contents: &'static str,
    executable: bool,
}

const RUST_CORE: &[TemplateFile] = &[
    TemplateFile {
        path: "Cargo.toml",
        contents: include_str!("../templates/plugin-new/rust-core/Cargo.toml"),
        executable: false,
    },
    TemplateFile {
        path: "src/lib.rs",
        contents: include_str!("../templates/plugin-new/rust-core/src/lib.rs"),
        executable: false,
    },
    TemplateFile {
        path: "plugin-sdk/Cargo.toml",
        contents: include_str!("../templates/plugin-new/rust-core/plugin-sdk/Cargo.toml"),
        executable: false,
    },
    TemplateFile {
        path: "plugin-sdk/src/lib.rs",
        contents: include_str!("../templates/plugin-new/rust-core/plugin-sdk/src/lib.rs"),
        executable: false,
    },
    TemplateFile {
        path: ".gitignore",
        contents: include_str!("../templates/plugin-new/rust-core/.gitignore"),
        executable: false,
    },
];

const RUST_COMPONENT: &[TemplateFile] = &[
    TemplateFile {
        path: "Cargo.toml",
        contents: include_str!("../templates/plugin-new/rust-component/Cargo.toml"),
        executable: false,
    },
    TemplateFile {
        path: "src/lib.rs",
        contents: include_str!("../templates/plugin-new/rust-component/src/lib.rs"),
        executable: false,
    },
    TemplateFile {
        path: "wit/plugin.wit",
        contents: include_str!("../templates/plugin-new/rust-component/wit/plugin.wit"),
        executable: false,
    },
    TemplateFile {
        path: "componentize/Cargo.toml",
        contents: include_str!("../templates/plugin-new/rust-component/componentize/Cargo.toml"),
        executable: false,
    },
    TemplateFile {
        path: "componentize/src/main.rs",
        contents: include_str!("../templates/plugin-new/rust-component/componentize/src/main.rs"),
        executable: false,
    },
    TemplateFile {
        path: "build-component.sh",
        contents: include_str!("../templates/plugin-new/rust-component/build-component.sh"),
        executable: true,
    },
    TemplateFile {
        path: ".gitignore",
        contents: include_str!("../templates/plugin-new/rust-component/.gitignore"),
        executable: false,
    },
];

const JS_COMPONENT: &[TemplateFile] = &[
    TemplateFile {
        path: "package.json",
        contents: include_str!("../templates/plugin-new/js-component/package.json"),
        executable: false,
    },
    TemplateFile {
        path: "component.js",
        contents: include_str!("../templates/plugin-new/js-component/component.js"),
        executable: false,
    },
    TemplateFile {
        path: "wit/plugin.wit",
        contents: include_str!("../templates/plugin-new/js-component/wit/plugin.wit"),
        executable: false,
    },
    TemplateFile {
        path: ".gitignore",
        contents: include_str!("../templates/plugin-new/js-component/.gitignore"),
        executable: false,
    },
];

pub fn create_plugin_scaffold(target: &Path, kind: ScaffoldKind) -> Result<ScaffoldReport> {
    if target.exists() {
        if !target.is_dir() {
            bail!(
                "scaffold target {} exists and is not a directory",
                target.display()
            );
        }
        if target
            .read_dir()
            .with_context(|| format!("reading {}", target.display()))?
            .next()
            .is_some()
        {
            bail!(
                "scaffold target {} is not empty; refusing to overwrite",
                target.display()
            );
        }
    } else {
        std::fs::create_dir_all(target)
            .with_context(|| format!("creating {}", target.display()))?;
    }

    let raw_name = target
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("plugin");
    let name = normalize_name(raw_name);
    let crate_stem = name.replace('-', "_");

    let files = match kind {
        ScaffoldKind::RustCore => RUST_CORE,
        ScaffoldKind::RustComponent => RUST_COMPONENT,
        ScaffoldKind::JsComponent => JS_COMPONENT,
    };

    let mut written = Vec::with_capacity(files.len() + 1);
    for file in files {
        let path = target.join(file.path);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating {}", parent.display()))?;
        }
        let contents = file
            .contents
            .replace("__PLUGIN_NAME__", &name)
            .replace("__CRATE_STEM__", &crate_stem);
        std::fs::write(&path, contents).with_context(|| format!("writing {}", path.display()))?;
        #[cfg(unix)]
        if file.executable {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = std::fs::metadata(&path)?.permissions();
            permissions.set_mode(0o755);
            std::fs::set_permissions(&path, permissions)?;
        }
        written.push(path);
    }

    let readme = scaffold_readme(&name, kind);
    let readme_path = target.join("README.md");
    std::fs::write(&readme_path, readme)
        .with_context(|| format!("writing {}", readme_path.display()))?;
    written.push(readme_path);

    Ok(ScaffoldReport {
        path: target.to_path_buf(),
        name,
        kind,
        files: written,
    })
}

fn normalize_name(raw: &str) -> String {
    let mut out = String::new();
    let mut separator = false;
    for ch in raw.chars() {
        let ch = ch.to_ascii_lowercase();
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
            separator = false;
        } else if !separator && !out.is_empty() {
            out.push('-');
            separator = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() {
        "plugin".to_string()
    } else {
        out
    }
}

fn scaffold_readme(name: &str, kind: ScaffoldKind) -> String {
    match kind {
        ScaffoldKind::RustCore => format!(
            "# {name}\n\nGenerated Rust core-module plugin.\n\nBuild:\n\n    rustup target add wasm32-wasip1\n    cargo build --release --target wasm32-wasip1\n\nValidate the resulting wasm with plugin-host plugin-check. Cargo replaces '-' with '_' in the wasm filename.\n"
        ),
        ScaffoldKind::RustComponent => format!(
            "# {name}\n\nGenerated Rust Component plugin using WIT 0.3.\n\nBuild and validate:\n\n    rustup target add wasm32-unknown-unknown\n    ./build-component.sh\n    plugin-host plugin-check target/plugin.component.wasm --json\n"
        ),
        ScaffoldKind::JsComponent => format!(
            "# {name}\n\nGenerated JavaScript Component plugin using WIT 0.3.\n\nBuild and validate:\n\n    npm install\n    npm run build\n    plugin-host plugin-check dist/plugin.component.wasm --json\n"
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static NEXT: AtomicUsize = AtomicUsize::new(0);

    fn temp_target(tag: &str) -> PathBuf {
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!("wph-scaffold-{}-{tag}-{n}", std::process::id()))
    }

    #[test]
    fn kind_aliases_parse() {
        assert_eq!(ScaffoldKind::parse("core"), Some(ScaffoldKind::RustCore));
        assert_eq!(
            ScaffoldKind::parse("rust"),
            Some(ScaffoldKind::RustComponent)
        );
        assert_eq!(ScaffoldKind::parse("js"), Some(ScaffoldKind::JsComponent));
        assert_eq!(ScaffoldKind::parse("python"), None);
    }

    #[test]
    fn rust_component_scaffold_bundles_wit() {
        let root = temp_target("component");
        let target = root.join("My Plugin");
        let _ = std::fs::remove_dir_all(&root);
        let report = create_plugin_scaffold(&target, ScaffoldKind::RustComponent).unwrap();
        assert_eq!(report.name, "my-plugin");
        assert!(target.join("wit/plugin.wit").is_file());
        assert!(target.join("src/lib.rs").is_file());
        let wit = std::fs::read_to_string(target.join("wit/plugin.wit")).unwrap();
        assert!(wit.contains("package wasm-plugin-host:plugin@0.3.0"));
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn js_component_scaffold_uses_v03_imports() {
        let target = temp_target("js");
        let _ = std::fs::remove_dir_all(&target);
        create_plugin_scaffold(&target, ScaffoldKind::JsComponent).unwrap();
        let source = std::fs::read_to_string(target.join("component.js")).unwrap();
        assert!(source.contains("host-log@0.3.0"));
        assert!(target.join("wit/plugin.wit").is_file());
        let _ = std::fs::remove_dir_all(target);
    }

    #[test]
    fn nonempty_target_is_never_overwritten() {
        let target = temp_target("occupied");
        let _ = std::fs::remove_dir_all(&target);
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("keep.txt"), "keep").unwrap();
        let error = create_plugin_scaffold(&target, ScaffoldKind::RustCore).unwrap_err();
        assert!(error.to_string().contains("not empty"));
        assert_eq!(
            std::fs::read_to_string(target.join("keep.txt")).unwrap(),
            "keep"
        );
        let _ = std::fs::remove_dir_all(target);
    }
}
