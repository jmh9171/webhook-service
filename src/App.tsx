import { useEffect, useState, type ComponentType } from "react";
import {
  Activity,
  ArrowUpRight,
  Braces,
  Clock3,
  Code2,
  FileDiff,
  FlaskConical,
  HeartPulse,
  House,
  Inbox,
  KeyRound,
  LogOut,
  Menu,
  ShieldCheck,
  Shuffle,
  Webhook,
  Workflow,
  X,
} from "lucide-react";
import { SessionGate } from "./Auth";
import { InboxPage } from "./Inbox";
import { ReplayPage, WorkflowPage } from "./features/Replay";
import { ContractPage, MutationPage } from "./features/Payload";
import { ComparePage, JsonPage } from "./features/Inspect";
import {
  EncodingPage,
  JwtPage,
  SignaturePage,
  TimePage,
} from "./features/Utilities";
import { ChaosPage, HeartbeatPage, MockPage } from "./features/Hosted";
import { TimelinePage } from "./features/Timeline";
import { ErrorBox, Note, useInbox, useLab } from "./lab-ui";
import "./lab.css";

type Icon = ComponentType<{ size?: number; strokeWidth?: number }>;
interface Tool {
  id: string;
  name: string;
  description: string;
  icon: Icon;
  group: string;
  location: string;
}
const tools: Tool[] = [
  {
    id: "inbox",
    name: "Webhook inbox",
    description:
      "Receive a request, inspect its original bytes, and copy it to Postman.",
    icon: Inbox,
    group: "Inspect",
    location: "Hosted",
  },
  {
    id: "compare",
    name: "Compare",
    description:
      "Find differences between two HTTP captures or JSON documents.",
    icon: FileDiff,
    group: "Inspect",
    location: "Browser",
  },
  {
    id: "contracts",
    name: "Contract detective",
    description: "Learn a payload’s structure and catch unexpected changes.",
    icon: Braces,
    group: "Inspect",
    location: "Browser",
  },
  {
    id: "signatures",
    name: "Signature checker",
    description:
      "Check HMAC signatures using the original body and your signing secret.",
    icon: ShieldCheck,
    group: "Inspect",
    location: "Browser",
  },
  {
    id: "replay",
    name: "Time machine",
    description:
      "Replay a recording at its original speed, faster, backward, or in a burst.",
    icon: Clock3,
    group: "Local replay",
    location: "Local script",
  },
  {
    id: "disorder",
    name: "Event disorder",
    description:
      "Duplicate, shuffle, or omit events to test delivery edge cases.",
    icon: Shuffle,
    group: "Local replay",
    location: "Local script",
  },
  {
    id: "mutation",
    name: "Payload mutation",
    description:
      "Generate missing fields, unexpected types, and unusual values.",
    icon: FlaskConical,
    group: "Local replay",
    location: "Local script",
  },
  {
    id: "workflows",
    name: "Workflow builder",
    description: "Arrange events, add delays, and change fields between steps.",
    icon: Workflow,
    group: "Local replay",
    location: "Local script",
  },
  {
    id: "chaos",
    name: "Chaos lab",
    description:
      "Create unreliable endpoints to test retries, errors, and slow responses.",
    icon: FlaskConical,
    group: "Hosted simulators",
    location: "Hosted",
  },
  {
    id: "mocks",
    name: "Mock APIs",
    description:
      "Build a fake API with multiple routes, pagination, auth, and rate limits.",
    icon: Code2,
    group: "Hosted simulators",
    location: "Hosted",
  },
  {
    id: "timeline",
    name: "Event timeline",
    description:
      "Follow related captures, delivery events, and alerts in one journey.",
    icon: Activity,
    group: "Monitor",
    location: "Hosted",
  },
  {
    id: "heartbeat",
    name: "Heartbeat watchdog",
    description:
      "Detect missing job pings and send alerts to a webhook receiver.",
    icon: HeartPulse,
    group: "Monitor",
    location: "Hosted",
  },
  {
    id: "json",
    name: "JSON workbench",
    description: "Validate, format, minify, and extract fields from JSON.",
    icon: Braces,
    group: "Utilities",
    location: "Browser",
  },
  {
    id: "jwt",
    name: "JWT inspector",
    description:
      "Decode claims and inspect token expiration without sending tokens away.",
    icon: KeyRound,
    group: "Utilities",
    location: "Browser",
  },
  {
    id: "encoding",
    name: "Encoding & hashes",
    description: "Convert Base64, URLs, JSON strings, and SHA-256 hashes.",
    icon: Code2,
    group: "Utilities",
    location: "Browser",
  },
  {
    id: "time",
    name: "Time & IDs",
    description: "Convert Unix timestamps and generate UUIDs for your tests.",
    icon: Clock3,
    group: "Utilities",
    location: "Browser",
  },
];
const groups = [
  "Inspect",
  "Local replay",
  "Hosted simulators",
  "Monitor",
  "Utilities",
];
function readPage() {
  const id = new URLSearchParams(location.hash.slice(1)).get("tool") || "home";
  return id === "home" || tools.some((t) => t.id === id) ? id : "home";
}
export default function App() {
  return (
    <SessionGate>
      {(username, signOut, loginRequired) => (
        <Workspace
          username={username}
          signOut={signOut}
          loginRequired={loginRequired}
        />
      )}
    </SessionGate>
  );
}
function Workspace({
  username,
  signOut,
  loginRequired,
}: {
  username: string;
  signOut: () => Promise<void>;
  loginRequired: boolean;
}) {
  const [page, setPage] = useState(readPage),
    [menu, setMenu] = useState(false),
    [failure, setFailure] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    const change = () => {
      setPage(readPage());
      setMenu(false);
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  useEffect(() => {
    document.title = `${tools.find((t) => t.id === page)?.name || "Your workspace"} · Webhook Lab`;
    document
      .querySelector<HTMLElement>("#page-content")
      ?.focus({ preventScroll: true });
  }, [page]);
  function navigate(id: string) {
    location.hash = `tool=${id}`;
    setMenu(false);
  }
  const active = tools.find((t) => t.id === page);
  return (
    <div className="lab-shell">
      <button
        className={menu ? "sidebar-shade open" : "sidebar-shade"}
        aria-label="Close navigation"
        onClick={() => setMenu(false)}
      />
      <aside
        className={menu ? "lab-sidebar open" : "lab-sidebar"}
        aria-label="Feature navigation"
      >
        <a className="lab-brand" href="#tool=home">
          <span>
            <Webhook size={23} />
          </span>
          <div>
            webhook <b>lab</b>
            <small>YOUR PERSONAL TESTING TOOLBOX</small>
          </div>
        </a>
        <button
          className={page === "home" ? "nav-home active" : "nav-home"}
          onClick={() => navigate("home")}
        >
          <House size={17} />
          Workspace overview
        </button>
        <nav>
          {groups.map((group) => (
            <section key={group}>
              <h2>{group}</h2>
              {tools
                .filter((t) => t.group === group)
                .map((tool) => (
                  <button
                    className={page === tool.id ? "active" : ""}
                    aria-current={page === tool.id ? "page" : undefined}
                    key={tool.id}
                    onClick={() => navigate(tool.id)}
                  >
                    <tool.icon size={16} />
                    <span>{tool.name}</span>
                  </button>
                ))}
            </section>
          ))}
        </nav>
        <div className="sidebar-footer">
          <span className="tiny-dot" />
          TEMPORARY BY DESIGN
          {loginRequired && (
            <button
              title="Sign out"
              aria-label="Sign out"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await signOut();
                } catch (e) {
                  setFailure((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <LogOut size={17} />
            </button>
          )}
        </div>
      </aside>
      <div className="app-body">
        <header className="lab-header">
          <div>
            <button
              className="icon-button mobile-menu"
              aria-label={
                menu ? "Close feature navigation" : "Open feature navigation"
              }
              onClick={() => setMenu(!menu)}
            >
              {menu ? <X size={20} /> : <Menu size={20} />}
            </button>
            <span>Workspace</span>
            <span className="header-divider">/</span>
            <strong>{active?.name || "Overview"}</strong>
          </div>
          <span className="lab-user">
            <span className="status-dot" />
            {username}
            <span className="user-avatar">
              {username.slice(0, 1).toUpperCase()}
            </span>
          </span>
        </header>
        <div id="page-content" tabIndex={-1}>
          <ErrorBox error={failure} />
          {page === "home" ? (
            <Home navigate={navigate} />
          ) : page === "inbox" ? (
            <InboxPage />
          ) : page === "compare" ? (
            <ComparePage />
          ) : page === "contracts" ? (
            <ContractPage />
          ) : page === "signatures" ? (
            <SignaturePage />
          ) : page === "replay" ? (
            <ReplayPage />
          ) : page === "disorder" ? (
            <ReplayPage key="disorder" disorder />
          ) : page === "mutation" ? (
            <MutationPage />
          ) : page === "workflows" ? (
            <WorkflowPage />
          ) : page === "chaos" ? (
            <ChaosPage />
          ) : page === "mocks" ? (
            <MockPage />
          ) : page === "timeline" ? (
            <TimelinePage />
          ) : page === "heartbeat" ? (
            <HeartbeatPage />
          ) : page === "json" ? (
            <JsonPage />
          ) : page === "jwt" ? (
            <JwtPage />
          ) : page === "encoding" ? (
            <EncodingPage />
          ) : (
            <TimePage />
          )}
        </div>
      </div>
    </div>
  );
}
function Home({ navigate }: { navigate: (id: string) => void }) {
  const { data: inbox, error: inboxError } = useInbox(),
    { data: lab, error: labError } = useLab();
  return (
    <main className="lab-page">
      <section className="lab-hero">
        <div>
          <span className="eyebrow">PERSONAL TOOLS / REAL-WORLD TESTING</span>
          <h1>
            A little less guesswork<span>.</span>
          </h1>
          <p>
            Catch what arrived. Explore what could go wrong.
            <br />
            Take the next test back to your machine.
          </p>
          <button className="button primary" onClick={() => navigate("inbox")}>
            Open your inbox
            <ArrowUpRight size={16} />
          </button>
        </div>
        <div className="hero-stats">
          <span>
            <strong>{inbox?.requests.length ?? "—"}</strong>captured requests
          </span>
          <span>
            <strong>
              {(lab?.mocks.length ?? 0) + (lab?.chaos.length ?? 0)}
            </strong>
            live simulators
          </span>
          <span>
            <strong>{lab?.watchdogs.length ?? "—"}</strong>heartbeat watches
          </span>
        </div>
      </section>
      <ErrorBox error={inboxError || labError} />
      <Note>
        Captures, hosted endpoints, watches, and events reset on restart or
        deployment. Your replay URL stays in this browser. Export workflows,
        contracts, and mock definitions to keep them.
      </Note>
      {groups.map((group, i) => (
        <section className="tool-section" key={group}>
          <div className="tool-section-heading">
            <div>
              <span className="technical">0{i + 1}</span>
              <h2>{group}</h2>
            </div>
            <p>
              {
                [
                  "Understand the requests you received.",
                  "Prepare tests that run against localhost.",
                  "Give your provider or frontend a controlled test endpoint.",
                  "See the journey and detect what stopped arriving.",
                  "Small, focused tools that run in your browser.",
                ][i]
              }
            </p>
          </div>
          <div className="tool-grid">
            {tools
              .filter((t) => t.group === group)
              .map((tool) => (
                <button
                  className="tool-card"
                  key={tool.id}
                  onClick={() => navigate(tool.id)}
                >
                  <div>
                    <span className="tool-icon">
                      <tool.icon size={22} strokeWidth={1.6} />
                    </span>
                    <span className="tool-location">{tool.location}</span>
                  </div>
                  <h3>
                    {tool.name}
                    <ArrowUpRight size={17} />
                  </h3>
                  <p>{tool.description}</p>
                </button>
              ))}
          </div>
        </section>
      ))}
      <footer className="lab-home-footer">
        WEBHOOK LAB <span>Made for the next “what if?”</span>
      </footer>
    </main>
  );
}
