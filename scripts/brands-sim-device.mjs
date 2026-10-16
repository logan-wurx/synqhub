// A fake WebHID device for the brand session simulators: answers each output report through a
// handler, asynchronously, the way HIDDevice delivers input reports. No hardware, no window.
export class SimDevice {
  constructor({ vendorId, productId, productName = "sim", collections = [], handler, inputReportId = 0 }) {
    this.vendorId = vendorId;
    this.productId = productId;
    this.productName = productName;
    this.collections = collections;
    this.opened = false;
    this.handler = handler;
    this.inputReportId = inputReportId;
    this.listeners = new Set();
    /** Every frame the device received, in order. */
    this.received = [];
  }
  async open() {
    this.opened = true;
  }
  async close() {
    this.opened = false;
  }
  addEventListener(type, fn) {
    if (type === "inputreport") this.listeners.add(fn);
  }
  removeEventListener(type, fn) {
    if (type === "inputreport") this.listeners.delete(fn);
  }
  async sendReport(reportId, data) {
    if (!this.opened) throw new Error("device not open");
    const f = new Uint8Array(data.buffer ? data.buffer.slice(data.byteOffset ?? 0, (data.byteOffset ?? 0) + data.byteLength) : data);
    this.received.push({ reportId, f });
    const reply = this.handler(f, reportId);
    if (!reply) return;
    const out = new Uint8Array(f.length);
    out.set(reply.slice(0, f.length));
    setTimeout(() => {
      for (const fn of this.listeners) fn({ reportId: this.inputReportId, data: new DataView(out.buffer) });
    }, 1);
  }
}

export const hex = (f) => Array.from(f, (b) => b.toString(16).padStart(2, "0")).join(" ");
export const u16 = (f, i) => f[i] | (f[i + 1] << 8);
