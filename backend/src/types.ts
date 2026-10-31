export const roles = [
  "passenger_home",
  "passenger_road",
  "passenger_terminal",
  "relative_arrivals",
  "taxi",
  "rideshare",
  "rent_a_car_ubt",
  "isu_smurd",
  "staff",
  "alt_airport",
  "public",
] as const;
export type Role = (typeof roles)[number];
/** Recovery order decided by the team: services and transport, then people nearby, then everyone else. */
export const waveRoles: readonly (readonly Role[])[] = [
  ["staff", "isu_smurd", "taxi", "rideshare", "rent_a_car_ubt"],
  ["passenger_road", "passenger_terminal", "relative_arrivals"],
  ["passenger_home", "public", "alt_airport"],
];
export const channels = ["telegram", "sms", "whatsapp", "webpush"] as const;
export type Channel = (typeof channels)[number];
export type Lang = "ro" | "en";
export type Situation =
  "runway_closed" | "evacuation" | "diverted" | "reopen_wave" | "reopened";
export type Phase = "normal" | "detection" | "suspended" | "recovery";
export interface Envelope {
  type: string;
  ts: string;
  data: Record<string, any>;
}
export interface Flight {
  flight: string;
  dir: "arr" | "dep";
  city: string;
  iata: string;
  sched: string;
  est: string;
  status: "scheduled" | "suspended" | "diverted" | "landed" | "departed";
  divertedTo?: string;
}
export type Location = "home" | "road" | "terminal" | "kerb" | "unknown";
export interface Subscription {
  location?: Location;
  lastInboundAt?: string;
  id: string;
  role: Role;
  flight?: string;
  channel: Channel;
  lang: Lang;
  destination?: string;
  source: "jury" | "relative" | "qr" | "direct";
  consent: true;
  expiresAt: string;
  date?: string;
  route?: string;
}
export interface Agent {
  location?: Location;
  action?: string;
  agentId: string;
  role: Role;
  channel: Channel;
  wave: number;
  state?: "notified" | "read" | "acting";
}
export interface Counter {
  subscribers: number;
  sent: number;
  delivered: number;
  read: number;
}
export interface Draft {
  messageId: string;
  role: Role;
  situation: Situation;
  lang: Lang;
  text: string;
  approved: boolean;
  flight?: string;
}
export interface Receipt {
  providerId?: string;
  id: string;
  role: Role;
  recipient: string;
  messageId: string;
  delivered: boolean;
  read: boolean;
  simulated: boolean;
  notifiedAt: string;
  deliveredAt?: string;
  readAt?: number;
  actAt?: number;
  acted?: boolean;
  willAct?: boolean;
}
export interface State {
  presence: Record<Role, Record<Location, number>>;
  drone: {
    lat: number;
    lon: number;
    distanceM: number;
    bearingDeg: number;
    nearRunway: "08" | "26";
    source: "radar" | "report";
    at: string;
  } | null;
  reach: {
    step: number;
    key: string;
    reached: number;
    status: "active" | "idle" | "draft";
  }[];
  phase: Phase;
  since: string;
  reason: string | null;
  evacuate: boolean;
  estimatedReopen: string;
  confirmedAt: string | null;
  flights: Flight[];
  drafts: Draft[];
  counters: Record<Role, Counter>;
  roalertDraft: string | null;
  waves: {
    wave: number;
    window: { from: string; to: string };
    roles: Role[];
    opened: boolean;
  }[];
  timeline: {
    type: string;
    ts: string;
    phase: Phase;
    data: Record<string, unknown>;
  }[];
  metrics: {
    notifiedFirstMinute: number;
    readCount: number;
    readRecipients: number;
    carsStartedInVain: number;
    isuTimeToT2:
      | number
      | {
          median: number;
          interval: [number, number];
          source: "sim-ab";
          units: "minutes";
          coverage: number;
          waves: boolean;
          model: string;
          intervalLabel: string;
        }
      | null;
    kerbPeak: number | null;
    peopleInT2AtEvacuation?: number;
    minutesLost?: number;
  };
  dataSource: string;
  dataSourceDetail?: string;
}
export const isRole = (v: unknown): v is Role => roles.includes(v as Role);
export const isChannel = (v: unknown): v is Channel =>
  channels.includes(v as Channel);
