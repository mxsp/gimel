import { Tag } from "@blueprintjs/core";
import { ORDER_PHASES, orderPhase } from "../status";

export default function OrderStatusTag({ order }: { order: Parameters<typeof orderPhase>[0] }) {
  const { label, intent, icon } = ORDER_PHASES[orderPhase(order)];
  return <Tag minimal intent={intent} icon={icon}>{label}</Tag>;
}
