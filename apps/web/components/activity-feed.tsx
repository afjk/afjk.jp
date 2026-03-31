import { ActivityEvent } from "@/lib/activity";

const sourceColors: Record<ActivityEvent["source"], string> = {
  twitter: "#1da1f2",
  github: "#6e7681",
  blog: "#f97316",
  session: "#c8ff00"
};

export function ActivityFeed({ events }: { events: ActivityEvent[] }) {
  return (
    <div className="activity-feed">
      {events.map((event) => (
        <article key={event.id} className="activity-card">
          <div
            className="activity-source"
            style={{ color: sourceColors[event.source] }}
          >
            {event.source.toUpperCase()}
          </div>
          <h3>
            {event.url ? (
              <a href={event.url} target="_blank" rel="noreferrer">
                {event.title}
              </a>
            ) : (
              event.title
            )}
          </h3>
          <footer>
            <time dateTime={event.timestamp}>
              {new Intl.DateTimeFormat("ja-JP", {
                month: "short",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit"
              }).format(new Date(event.timestamp))}
            </time>
            {event.meta && <span>{event.meta}</span>}
          </footer>
        </article>
      ))}
    </div>
  );
}
