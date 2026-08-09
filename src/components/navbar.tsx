import { Home, Images, Settings } from "lucide-react";
import { NavLink } from "react-router";

export function Navbar() {
    return (
        <div className={"dock"}>
            <NavLink to={"/"} end className={({ isActive }) => (isActive ? "dock-active" : "")}>
                <Home />
                <span className="dock-label">Home</span>
            </NavLink>

            <NavLink to={"/gallery"} className={({ isActive }) => (isActive ? "dock-active" : "")}>
                <Images />
                <span className="dock-label">Gallery</span>
            </NavLink>

            <NavLink to={"/settings"} className={({ isActive }) => (isActive ? "dock-active" : "")}>
                <Settings />
                <span className="dock-label">Settings</span>
            </NavLink>
        </div>
    );
}
