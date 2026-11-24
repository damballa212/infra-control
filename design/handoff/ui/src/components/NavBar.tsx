import { useId } from "react";
import { Link, branchOf, type Branch, type Route } from "../lib/router.tsx";
import { useAppState } from "../app/AppState.tsx";

import { Icon, type IconName } from "./ui.tsx";
interface NavItem { branch: Branch; to: Route; label: string; icon: IconName; desktopOnly?: boolean }
const ITEMS: readonly NavItem[] = [
  { branch: "control", to: { name: "control" }, label: "Hoy", icon: "home" },
  { branch: "inventory", to: { name: "inventory", view: "services" }, label: "Inventario", icon: "inventory" },
  { branch: "activity", to: { name: "activity" }, label: "Actividad", icon: "activity" },
  { branch: "agents", to: { name: "agents" }, label: "Agentes", icon: "agents" },
  { branch: "costs", to: { name: "costs" }, label: "Costes", icon: "costs", desktopOnly: true },
];
export function NavBar({ route }: { route: Route }) {
  const app = useAppState(); const id = useId(); const active = branchOf(route);
  const resources = app.inventory.data?.resources ?? [];
  const todayCount = app.attention?.data && !app.attention.error ? app.attention.data.counts.attentionGroups : 0;
  const inventoryView = route.name === "inventory" ? route.view : null;
  return <nav className="nav" aria-label="Navegación principal"><Link to="/" className="nav__brand">infra<i>·</i>control</Link>{ITEMS.map(item => {
    const count = item.branch === "control" ? todayCount : item.branch === "agents" ? app.secretsPending : 0;
    const description = item.branch === "control" ? `${count} grupos de atención` : `${count} te espera`;
    const descriptionId = `${id}-${item.branch}-count`;
    return <div key={item.branch} className={item.desktopOnly ? "only-desktop" : "nav__cell"}><Link to={item.to} className="nav__item" aria-label={item.label} aria-describedby={count > 0 ? descriptionId : undefined} aria-current={active === item.branch ? "page" : undefined}><Icon name={item.icon} className="nav__icon" />{item.label}{count > 0 && <><i className="badge" aria-hidden="true">{count}</i><span className="visually-hidden" id={descriptionId}>{description}</span></>}</Link>{item.branch === "inventory" && <><Link className="nav__item nav__sub" to={{ name: "inventory", view: "services" }} aria-current={inventoryView === "services" ? "page" : undefined}>Servicios</Link><Link className="nav__item nav__sub" to={{ name: "inventory", view: "devices" }} aria-current={inventoryView === "devices" ? "page" : undefined}>Equipos<span className="nav__count">{resources.length || ""}</span></Link><Link className="nav__item nav__sub" to={{ name: "inventory", view: "map" }} aria-current={inventoryView === "map" ? "page" : undefined}>Mapa</Link></>}</div>;
  })}<div className="nav__spacer" /><Link to={{ name: "me", tab: "system" }} className="nav__me" aria-current={active === "me" ? "page" : undefined}><span className="avatar" aria-hidden="true">M</span><span className="grow">Admin<small>Tú · sistema y ajustes</small></span></Link></nav>;
}
