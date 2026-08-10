import { Home, Images, Loader2, Settings } from "lucide-react";
import { NavLink } from "react-router";
import { useJobs } from "../lib/jobs.tsx";

export function Navbar() {
    const jobs = useJobs();
    const progress = jobs.sync.running ? jobs.sync.progress : jobs.verify.progress;

    return (
        <div className={"dock"}>
            <NavLink to={"/"} end className={({ isActive }) => (isActive ? "dock-active" : "")}>
                <div className="indicator">
                    {jobs.busy && (
                        <span className="indicator-item badge badge-primary badge-xs flex items-center gap-0.5 px-1">
                            <Loader2 size={9} className="animate-spin" />
                            {progress && progress.total > 0 ? `${progress.done}/${progress.total}` : ""}
                        </span>
                    )}
                    <Home />
                </div>
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
