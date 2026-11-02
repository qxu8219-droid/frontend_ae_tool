import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import "./style.css";

async function main() {
  let runtime;
  if (import.meta.env.VITE_USE_MOCK === "true") {
    const mocks = await import("./mocks/browser");
    await mocks.startMocks();
    runtime = (await import("./mocks/runtime")).mockRuntime;
    window.addEventListener("pagehide", mocks.stopMocks, { once: true });
  }
  createApp(App, { runtime }).use(createPinia()).mount("#app");
}
main().catch((error) => {
  const root = document.getElementById("app")!;
  root.textContent = `工作台初始化失败：${error instanceof Error ? error.message : String(error)}`;
  root.setAttribute("role", "alert");
});
