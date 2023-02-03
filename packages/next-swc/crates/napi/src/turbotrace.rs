use std::sync::Arc;

use napi::bindgen_prelude::*;
use next_binding::turbo::node_file_trace::{start, Args, CommonArgs};

#[napi]
pub fn run_turbo_tracing(mut env: Env, options: Buffer) -> napi::Result<Object> {
    let args: Args = serde_json::from_slice(options.as_ref())?;
    let limit = if let CommonArgs {
        memory_limit: Some(limit),
        ..
    } = match &args {
        Args::Print { common, .. }
        | Args::Annotate { common, .. }
        | Args::Build { common, .. }
        | Args::Size { common, .. } => common,
    } {
        *limit * 1024 * 1024
    } else {
        0
    };
    env.adjust_external_memory(limit as i64)?;
    env.execute_tokio_future(
        async move {
            let files = start(Arc::new(args)).await?;
            Ok(files)
        },
        move |env, output| {
            env.adjust_external_memory(-(limit as i64))?;
            Ok(output)
        },
    )
}
