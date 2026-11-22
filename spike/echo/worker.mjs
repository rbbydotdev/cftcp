import { DurableObject } from "cloudflare:workers";
export class Box extends DurableObject {
  async connect(socket) {
    const w = socket.writable.getWriter();
    await w.write(new TextEncoder().encode("hello from DO\n"));
    for await (const chunk of socket.readable) await w.write(chunk);
  }
}
export default {
  async connect(socket, env) {
    const stub = env.BOX.getByName("default");
    const up = stub.connect("box:22", { allowHalfOpen: true, secureTransport: "off" });
    await up.opened;
    await Promise.allSettled([socket.readable.pipeTo(up.writable), up.readable.pipeTo(socket.writable)]);
  },
};
