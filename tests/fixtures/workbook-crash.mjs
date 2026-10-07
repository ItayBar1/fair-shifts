process.once("message", () => process.kill(process.pid, "SIGKILL"));
