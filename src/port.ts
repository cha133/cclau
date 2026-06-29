// 顺序端口探测：起 3133，占了 +1 顺延

async function isPortFree(port: number): Promise<boolean> {
  try {
    const server = Bun.listen({
      port,
      hostname: "127.0.0.1",
      socket: { open() {}, close() {}, data() {} },
    });
    server.stop(true);
    return true;
  } catch {
    return false;
  }
}

export async function findFreePort(start = 3133): Promise<number> {
  for (let p = start; p < start + 1000; p++) {
    if (await isPortFree(p)) return p;
  }
  throw new Error(`No free port found in [${start}, ${start + 1000})`);
}