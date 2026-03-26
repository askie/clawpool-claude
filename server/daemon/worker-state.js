function normalizeString(value) {
  return String(value ?? "").trim();
}

export function hasWorkerControl(binding) {
  return Boolean(binding?.worker_control_url && binding?.worker_control_token);
}

export function normalizeWorkerResponseState(value) {
  const normalized = normalizeString(value);
  if (
    normalized === "unknown"
    || normalized === "unverified"
    || normalized === "healthy"
    || normalized === "failed"
  ) {
    return normalized;
  }
  return "unknown";
}

export function canDeliverToWorker(binding) {
  const status = normalizeString(binding?.worker_status);
  const responseState = normalizeWorkerResponseState(binding?.worker_response_state);
  return hasWorkerControl(binding) && status === "ready" && responseState !== "failed";
}

export function formatWorkerResponseAssessment(binding) {
  const workerStatus = normalizeString(binding?.worker_status);
  const responseState = normalizeWorkerResponseState(binding?.worker_response_state);

  if (workerStatus === "ready") {
    if (responseState === "healthy") {
      return "可用（最近一次真实交互已验证）";
    }
    if (responseState === "failed") {
      return "异常（最近一次真实交互失败）";
    }
    return "待验证（已就绪，但还没有真实交互证明）";
  }

  if (workerStatus === "starting" || workerStatus === "connected") {
    return "启动中";
  }
  if (workerStatus === "stopped") {
    return "已停止";
  }
  if (workerStatus === "failed") {
    return "已失败";
  }
  return "未知";
}
