import { beforeEach, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useHistoryStore } from "../../src/stores/history";
import { alert, channels, curve, frame } from "./fixtures";
beforeEach(() => setActivePinia(createPinia()));
it("replaces duplicate channel/time history values and rejects a retired log", () => {
  const s = useHistoryStore();
  s.setContext("s", "l");
  s.setChannels(channels);
  const c = curve();
  c.series[0].points.push({ ...c.series[0].points[0], value: 9 });
  s.setCurve(c);
  expect(s.curve?.series[0].points.map((p) => p.value)).toEqual([9, 0, 2]);
  s.setCurve(curve("retired"));
  expect(s.curve?.log_id).toBe("l");
});
it("keeps prescanned events separate from playback-triggered alerts and filters severity", () => {
  const s = useHistoryStore();
  s.setContext("s", "l");
  s.setCurve(curve());
  expect(s.events.map((e) => e.time_s)).toEqual([2, 5]);
  expect(s.triggered).toEqual([]);
  s.severity = "error";
  expect(s.filteredEvents.map((e) => e.time_s)).toEqual([5]);
  s.view = "triggered";
  expect(s.filteredEvents).toEqual([]);
});
it("never releases a future alert before its actual image and deduplicates repeated delivery", () => {
  const s = useHistoryStore();
  s.setContext("s", "l");
  s.ingestAlert(alert());
  s.present(frame(1));
  expect(s.triggered).toEqual([]);
  s.present(frame(2));
  expect(s.triggered).toHaveLength(1);
  s.ingestAlert({ ...alert(2, 1, "duplicate"), message: "Updated warning" });
  expect(s.triggered).toHaveLength(1);
  expect(s.triggered[0].message).toBe("Updated warning");
});
it("gates delayed alerts by epoch, clears current-run alerts on backward seek, and rejects another session", () => {
  const s = useHistoryStore();
  s.setContext("s", "l");
  s.present(frame(6));
  s.ingestAlert(alert(5));
  expect(s.triggered).toHaveLength(1);
  s.present(frame(0, 2));
  expect(s.triggered).toEqual([]);
  s.ingestAlert(alert(6, 1));
  s.ingestAlert(alert(3, 2));
  s.present(frame(4, 2, "old"));
  expect(s.triggered).toEqual([]);
  s.present(frame(3, 2));
  expect(s.triggered.map((a) => a.log_time_s)).toEqual([3]);
  s.present(frame(8, 1));
  expect(s.triggered).toHaveLength(1);
});
it("drops log-scoped state when switching and limits selected channels to four known names", () => {
  const s = useHistoryStore();
  s.setContext("s", "l");
  s.setChannels(channels);
  s.setSelected(["a", "b", "c", "d", "e", "a", "unknown"]);
  expect(s.selected).toEqual(["a", "b", "c", "d"]);
  s.setCurve(curve());
  s.present(frame(5));
  s.ingestAlert(alert());
  s.setContext("s", "next");
  expect(s.curve).toBeNull();
  expect(s.channels).toEqual([]);
  expect(s.triggered).toEqual([]);
  expect(s.events).toEqual([]);
});
it("chooses a bounded torso, both arms and a prismatic gripper when canonical channels exist", () => {
  const s = useHistoryStore();
  s.setContext("s", "l");
  s.setChannels(
    [
      "steer_motor_joint1",
      "torso_joint1",
      "left_arm_joint1",
      "right_arm_joint1",
      "right_gripper_finger_joint2",
    ].map((name, index) => ({ ...channels[index], name })),
  );
  expect(s.selected).toEqual([
    "torso_joint1",
    "left_arm_joint1",
    "right_arm_joint1",
    "right_gripper_finger_joint2",
  ]);
});
it("lists both prescanned and played events newest first after filtering", () => {
  const s = useHistoryStore();
  s.setContext("s", "l");
  s.setCurve(curve());
  expect(s.filteredEvents.map((event) => event.time_s)).toEqual([5, 2]);
  s.present(frame(6));
  s.ingestAlert(alert(2));
  s.ingestAlert({ ...alert(5, 1, "second"), severity: "error" });
  s.view = "triggered";
  expect(s.filteredEvents.map((event) => event.time_s)).toEqual([5, 2]);
  s.severity = "warning";
  expect(s.filteredEvents.map((event) => event.time_s)).toEqual([2]);
});
