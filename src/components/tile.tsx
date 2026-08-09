import { useEffect, useRef, useState } from "react";
import { Cloud, CloudOff, Film, Loader2 } from "lucide-react";

export type CloudState = "checking" | "in" | "out";

type Loaded = { src: string; badge?: string; isVideo?: boolean };

/**
 * A single square gallery tile. Lazily runs `load()` (via IntersectionObserver) to fetch its
 * thumbnail — and, for Immich library tiles, its badge/video metadata — only when scrolled near.
 * A format badge sits top-left; the cloud/no-cloud state sits top-right.
 */
export function PhotoTile({
  badge: staticBadge,
  isVideo: staticVideo,
  cloud,
  load,
}: {
  badge?: string;
  isVideo?: boolean;
  cloud?: CloudState;
  load: () => Promise<Loaded>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const [data, setData] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let done = false;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && !done) {
          done = true;
          io.disconnect();
          loadRef.current()
            .then(setData)
            .catch(() => setFailed(true));
        }
      },
      { rootMargin: "300px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const badge = data?.badge ?? staticBadge;
  const isVideo = data?.isVideo ?? staticVideo;

  return (
    <div ref={ref} className="relative aspect-square overflow-hidden rounded-md bg-base-300">
      {data ? (
        <img src={data.src} alt={badge ?? ""} className="h-full w-full object-cover" />
      ) : failed ? (
        <div className="flex h-full w-full items-center justify-center px-1 text-center text-[10px] opacity-50">
          no preview
        </div>
      ) : (
        <div className="flex h-full w-full items-center justify-center">
          <Loader2 size={16} className="animate-spin opacity-40" />
        </div>
      )}

      {badge && (
        <span className="absolute left-1 top-1 rounded bg-black/60 px-1 text-[10px] font-semibold leading-4 text-white">
          {badge}
        </span>
      )}

      {isVideo && (
        <span className="absolute bottom-1 left-1 text-white drop-shadow">
          <Film size={14} />
        </span>
      )}

      {cloud && (
        <span className="absolute right-1 top-1 drop-shadow">
          {cloud === "checking" && <Loader2 size={14} className="animate-spin text-white/80" />}
          {cloud === "in" && <Cloud size={14} className="text-success" fill="currentColor" />}
          {cloud === "out" && <CloudOff size={14} className="text-warning" />}
        </span>
      )}
    </div>
  );
}
