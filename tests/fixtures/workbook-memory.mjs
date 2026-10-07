process.once("message", () => {
  const retained = [];
  setInterval(() => retained.push(Buffer.alloc(4 * 1024 * 1024, 0x41)), 25);
});
