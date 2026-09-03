const localtunnel = require("localtunnel");

async function startTunnel() {
  try {
    const tunnel = await localtunnel({ port: 5000, subdomain: "simlytel-backend-live" });
    console.log("[BACKEND TUNNEL LIVE]: " + tunnel.url);
    tunnel.on("close", () => {
      console.log("Tunnel closed, restarting in 3s...");
      setTimeout(startTunnel, 3000);
    });
    tunnel.on("error", (err) => {
      console.error("Tunnel error:", err);
      setTimeout(startTunnel, 3000);
    });
  } catch (err) {
    console.error("Failed to start tunnel:", err.message);
    setTimeout(startTunnel, 3000);
  }
}

startTunnel();
