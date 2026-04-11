import { useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  BarChart,
  Bar,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { Search, Check } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "../lib/utils";
import { useCompany } from "../context/CompanyContext";
import { analyticsApi } from "../api/analytics";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import type { Issue } from "@paperclipai/shared";

const DAY_PRESETS = [
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
] as const;

function InitiativeFilterPicker({ initiatives, value, onChange }: {
  initiatives: Issue[];
  value: string;
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    if (!search.trim()) return initiatives;
    const q = search.toLowerCase();
    return initiatives.filter(i =>
      i.title.toLowerCase().includes(q) ||
      (i.identifier && i.identifier.toLowerCase().includes(q))
    );
  }, [initiatives, search]);

  const selected = initiatives.find(i => i.id === value);

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (o) setTimeout(() => inputRef.current?.focus(), 50); }}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1.5 text-xs border border-border rounded-md px-2 py-1.5 bg-transparent text-foreground hover:bg-accent/50 transition-colors max-w-[260px]"
        >
          <span className="truncate">
            {selected ? `${selected.identifier ?? ""}: ${selected.title}` : "All initiatives"}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-80 p-0" align="start">
        <div className="p-2 border-b border-border">
          <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-accent/30">
            <Search className="h-3 w-3 text-muted-foreground shrink-0" />
            <input
              ref={inputRef}
              className="flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground/60"
              placeholder="Search initiatives..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
        <div className="max-h-64 overflow-y-auto p-1">
          <button
            type="button"
            className={cn(
              "flex items-center justify-between w-full px-2 py-1.5 text-xs rounded-sm",
              !value ? "bg-accent/50 text-foreground" : "hover:bg-accent/50 text-muted-foreground",
            )}
            onClick={() => { onChange(""); setOpen(false); setSearch(""); }}
          >
            <span>All initiatives</span>
            {!value && <Check className="h-3 w-3 shrink-0" />}
          </button>
          {filtered.map((init) => (
            <button
              key={init.id}
              type="button"
              className={cn(
                "flex items-center justify-between w-full px-2 py-1.5 text-xs rounded-sm",
                init.id === value ? "bg-accent/50 text-foreground" : "hover:bg-accent/50 text-muted-foreground",
              )}
              onClick={() => { onChange(init.id); setOpen(false); setSearch(""); }}
            >
              <span className="truncate">
                {init.identifier ? <span className="text-muted-foreground mr-1">{init.identifier}</span> : null}
                {init.title}
              </span>
              {init.id === value && <Check className="h-3 w-3 shrink-0" />}
            </button>
          ))}
          {filtered.length === 0 && (
            <div className="px-2 py-3 text-xs text-muted-foreground text-center">No initiatives found</div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

interface FlowAnalyticsProps {
  issues: Issue[];
}

export function FlowAnalytics({ issues }: FlowAnalyticsProps) {
  const { selectedCompanyId } = useCompany();
  const [days, setDays] = useState(30);
  const [deptLabelId, setDeptLabelId] = useState<string>("");
  const [initiativeId, setInitiativeId] = useState<string>("");

  const { data: labelsList } = useQuery({
    queryKey: queryKeys.issues.labels(selectedCompanyId!),
    queryFn: () => issuesApi.listLabels(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const deptLabels = useMemo(
    () => (labelsList ?? []).filter((l) => l.name.startsWith("dept:")),
    [labelsList],
  );

  const initiatives = useMemo(
    () =>
      issues
        .filter((i) => i.issueType === "initiative")
        .sort((a, b) => {
          const numA = a.identifier ? parseInt(a.identifier.replace(/\D/g, ""), 10) : 0;
          const numB = b.identifier ? parseInt(b.identifier.replace(/\D/g, ""), 10) : 0;
          return numA - numB;
        }),
    [issues],
  );

  const queryParams = { days, deptLabelId: deptLabelId || undefined, initiativeId: initiativeId || undefined };

  const { data: throughputData = [], isLoading: throughputLoading } = useQuery({
    queryKey: ["analytics", "throughput", selectedCompanyId, queryParams],
    queryFn: () => analyticsApi.throughput(selectedCompanyId!, queryParams),
    enabled: !!selectedCompanyId,
  });

  const { data: flowData = [], isLoading: flowLoading } = useQuery({
    queryKey: ["analytics", "flow", selectedCompanyId, queryParams],
    queryFn: () => analyticsApi.flow(selectedCompanyId!, queryParams),
    enabled: !!selectedCompanyId,
  });

  const throughputSummary = useMemo(() => {
    const totalDone = throughputData.reduce((s, r) => s + r.done, 0);
    const totalCancelled = throughputData.reduce((s, r) => s + r.cancelled, 0);
    const avgPerDay = throughputData.length > 0 ? totalDone / throughputData.length : 0;
    return { totalDone, totalCancelled, avgPerDay };
  }, [throughputData]);

  const flowSummary = useMemo(() => {
    if (flowData.length === 0) return { backlog: 0, active: 0, review: 0, blocked: 0, terminal: 0 };
    const latest = flowData[flowData.length - 1]!;
    return latest;
  }, [flowData]);

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1 border border-border rounded-md overflow-hidden">
          {DAY_PRESETS.map((preset) => (
            <button
              key={preset.days}
              className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                days === preset.days
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
              onClick={() => setDays(preset.days)}
            >
              {preset.label}
            </button>
          ))}
        </div>

        {deptLabels.length > 0 && (
          <select
            className="text-xs border border-border rounded-md px-2 py-1.5 bg-transparent text-foreground"
            value={deptLabelId}
            onChange={(e) => setDeptLabelId(e.target.value)}
          >
            <option value="">All departments</option>
            {deptLabels.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        )}

        {initiatives.length > 0 && (
          <InitiativeFilterPicker
            initiatives={initiatives}
            value={initiativeId}
            onChange={setInitiativeId}
          />
        )}
      </div>

      {/* Throughput Chart */}
      <div className="space-y-3">
        <div className="flex items-baseline gap-4">
          <h3 className="text-sm font-semibold">Throughput</h3>
          <div className="flex gap-4 text-xs text-muted-foreground">
            <span>
              {throughputSummary.totalDone} done
            </span>
            <span>
              {throughputSummary.totalCancelled} cancelled
            </span>
            <span>
              {throughputSummary.avgPerDay.toFixed(1)}/day avg
            </span>
          </div>
        </div>

        <div className="h-48 w-full">
          {throughputLoading ? (
            <div className="h-full flex items-center justify-center text-xs text-muted-foreground">
              Loading...
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={throughputData} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 10 }}
                  tickFormatter={(v: string) => v.slice(5)}
                  className="text-muted-foreground"
                />
                <YAxis tick={{ fontSize: 10 }} allowDecimals={false} className="text-muted-foreground" />
                <Tooltip
                  contentStyle={{ fontSize: 12, borderRadius: 6, border: "1px solid hsl(var(--border))" }}
                  labelFormatter={(v) => String(v)}
                />
                <Bar dataKey="done" name="Done" fill="#22c55e" radius={[2, 2, 0, 0]} />
                <Bar dataKey="cancelled" name="Cancelled" fill="#a1a1aa" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* CFD-lite (Cumulative Flow) */}
      <div className="space-y-3">
        <div className="flex items-baseline gap-4">
          <h3 className="text-sm font-semibold">Cumulative Flow</h3>
          <div className="flex gap-4 text-xs text-muted-foreground">
            <span>{flowSummary.backlog} backlog</span>
            <span>{flowSummary.active} active</span>
            <span>{flowSummary.review} review</span>
            <span>{flowSummary.blocked} blocked</span>
            <span>{flowSummary.terminal} terminal</span>
          </div>
        </div>

        <div className="h-48 w-full">
          {flowLoading ? (
            <div className="h-full flex items-center justify-center text-xs text-muted-foreground">
              Loading...
            </div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={flowData} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
                <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 10 }}
                  tickFormatter={(v: string) => v.slice(5)}
                  className="text-muted-foreground"
                />
                <YAxis tick={{ fontSize: 10 }} allowDecimals={false} className="text-muted-foreground" />
                <Tooltip
                  contentStyle={{ fontSize: 12, borderRadius: 6, border: "1px solid hsl(var(--border))" }}
                  labelFormatter={(v) => String(v)}
                />
                <Area type="monotone" dataKey="terminal" name="Terminal" stackId="1" fill="#22c55e" stroke="#22c55e" fillOpacity={0.6} />
                <Area type="monotone" dataKey="review" name="In Review" stackId="1" fill="#8b5cf6" stroke="#8b5cf6" fillOpacity={0.6} />
                <Area type="monotone" dataKey="active" name="Active" stackId="1" fill="#3b82f6" stroke="#3b82f6" fillOpacity={0.6} />
                <Area type="monotone" dataKey="blocked" name="Blocked" stackId="1" fill="#ef4444" stroke="#ef4444" fillOpacity={0.6} />
                <Area type="monotone" dataKey="backlog" name="Backlog" stackId="1" fill="#a1a1aa" stroke="#a1a1aa" fillOpacity={0.6} />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </div>
  );
}
