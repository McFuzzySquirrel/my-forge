const response = await fetch("http://127.0.0.1:8083/health/ready", {
  signal: AbortSignal.timeout(2_000),
});

if (!response.ok) process.exitCode = 1;
