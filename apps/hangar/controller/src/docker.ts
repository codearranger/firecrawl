/**
 * Minimal Docker Engine API client. Talks to a docker-socket-proxy (never the
 * raw socket) that only allows the container endpoints.
 */
const DOCKER_HOST = (process.env.DOCKER_HOST ?? "tcp://hangar-docker-proxy:2375")
  .replace(/^tcp:\/\//, "http://")
  .replace(/\/$/, "");
const API = "/v1.45";

export class DockerError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${DOCKER_HOST}${API}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  if (!res.ok) throw new DockerError(res.status, `${method} ${path}: ${res.status} ${text}`);
  return (text ? JSON.parse(text) : {}) as T;
}

export type ContainerSpec = {
  name: string;
  image: string;
  env: Record<string, string>;
  labels: Record<string, string>;
  network: string;
  mounts: { volume: string; subpath: string; target: string; readOnly: boolean }[];
  memoryBytes: number;
  nanoCpus: number;
  pidsLimit: number;
  shmBytes: number;
  runtime?: string;
};

export async function createContainer(spec: ContainerSpec): Promise<string> {
  const body = {
    Image: spec.image,
    Env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
    Labels: spec.labels,
    User: "10001:10001",
    HostConfig: {
      NetworkMode: spec.network,
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      Privileged: false,
      Memory: spec.memoryBytes,
      MemorySwap: spec.memoryBytes,
      NanoCpus: spec.nanoCpus,
      PidsLimit: spec.pidsLimit,
      ShmSize: spec.shmBytes,
      Tmpfs: { "/tmp": "rw,nosuid,nodev,size=2g,mode=1777" },
      Mounts: spec.mounts.map(m => ({
        Type: "volume",
        Source: m.volume,
        Target: m.target,
        ReadOnly: m.readOnly,
        VolumeOptions: { Subpath: m.subpath, NoCopy: true },
      })),
      RestartPolicy: { Name: "no" },
      LogConfig: { Type: "json-file", Config: { "max-size": "5m", "max-file": "1" } },
      ...(spec.runtime ? { Runtime: spec.runtime } : {}),
    },
    NetworkingConfig: { EndpointsConfig: { [spec.network]: {} } },
  };
  const created = await call<{ Id: string }>(
    "POST",
    `/containers/create?name=${encodeURIComponent(spec.name)}`,
    body,
  );
  await call("POST", `/containers/${created.Id}/start`);
  return created.Id;
}

export type ContainerInfo = {
  running: boolean;
  exitCode: number;
  ip: string | null;
};

export async function inspectContainer(id: string, network: string): Promise<ContainerInfo | null> {
  try {
    const info = await call<any>("GET", `/containers/${id}/json`);
    return {
      running: !!info.State?.Running,
      exitCode: info.State?.ExitCode ?? 0,
      ip: info.NetworkSettings?.Networks?.[network]?.IPAddress || null,
    };
  } catch (error) {
    if (error instanceof DockerError && error.status === 404) return null;
    throw error;
  }
}

export async function stopContainer(id: string, timeoutSec = 20): Promise<void> {
  try {
    await call("POST", `/containers/${id}/stop?t=${timeoutSec}`);
  } catch (error) {
    if (!(error instanceof DockerError && (error.status === 304 || error.status === 404))) throw error;
  }
}

export async function removeContainer(id: string): Promise<void> {
  try {
    await call("DELETE", `/containers/${id}?force=true`);
  } catch (error) {
    if (!(error instanceof DockerError && error.status === 404)) throw error;
  }
}

export async function listContainers(label: string): Promise<{ Id: string; Labels: Record<string, string> }[]> {
  const filters = encodeURIComponent(JSON.stringify({ label: [label] }));
  return await call("GET", `/containers/json?all=true&filters=${filters}`);
}
