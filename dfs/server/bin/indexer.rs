use clap::{Parser, ValueEnum};

/// The task queues each deployment polls (TRANSACTIONAL_OUTBOUND.md#deployments).
#[derive(Clone, Copy, Debug, ValueEnum)]
enum Role {
    /// `dfs-relay` and `dfs-router`.
    Core,
    /// `dfs-index`.
    Index,
    /// `dfs-extract`.
    Extract,
}

#[derive(Parser)]
#[command(about = "Run DFS indexing pipeline workers")]
struct Args {
    #[arg(long, value_enum, env = "DFS_INDEXER_ROLE")]
    role: Role,
}

/**
 * @cc [owner:flvndvd,label:concurrency] indexer-graceful-shutdown
 * On SIGINT or SIGTERM, workers MUST stop polling for new tasks and let in-flight activities finish
 * or fail within their timeouts before the process exits.
 */
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = Args::parse();
    todo!("run the {:?} workers", args.role)
}
