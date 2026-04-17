/**
 * F1 entity document schemas.
 *
 * This is the single source of truth for all F1 entity types persisted in MongoDB.
 * There are 16 typed collections (see F1_COLL below), each with its own document
 * interface extending either F1ReferenceDocument (for identity/reference entities
 * like Driver, Constructor) or F1FactDocument (for extracted facts like RaceResult).
 *
 * Design pillars:
 *  - Strictly typed numeric fields (lap times in ms as numbers, not strings) so
 *    aggregation queries are mathematically reliable.
 *  - aliases[] on reference entities so "Max", "VER", "Max Verstappen" all resolve
 *    to the same entityId during extraction.
 *  - provenance[] on every fact so any quantitative answer can be audited back
 *    to the exact source document chunk.
 */

// ---------------------------------------------------------------------------
// Provenance attached to every extracted fact
// ---------------------------------------------------------------------------

export type FactProvenance = {
  sourceFileId: string;
  sourceChunkIds: string[]; // embedding chunk IDs the fact was extracted from
  sourceSpan?: string; // short verbatim quote from the document (for audit)
  confidence: number; // 0..1 from the extractor LLM
};

// ---------------------------------------------------------------------------
// Shared base types
// ---------------------------------------------------------------------------

export type F1BaseDocument = {
  orgId: string;
  entityId: string;
  name: string;
  nameLower: string; // indexed for alias-aware lookup
  sourceFileIds: string[]; // $addToSet across all files that mentioned this entity
  createdAt: string;
  updatedAt: string;
};

/** Reference entities carry aliases for entity resolution. */
export type F1ReferenceDocument = F1BaseDocument & {
  aliases: string[]; // e.g. Driver: ["Max", "VER", "Max Verstappen"]
  aliasesLower: string[]; // lowercased copies, indexed
};

/** Result / event entities carry provenance per fact. */
export type F1FactDocument = F1BaseDocument & {
  provenance: FactProvenance[]; // one entry per source file that mentioned this fact
};

// ---------------------------------------------------------------------------
// Tier 1 — reference entities
// ---------------------------------------------------------------------------

export type DriverDocument = F1ReferenceDocument & {
  nationality?: string;
  number?: number; // permanent driver number
  dateOfBirth?: string; // ISO date
};

export type ConstructorDocument = F1ReferenceDocument & {
  base?: string;
  powerUnit?: string; // e.g. "Honda RBPT", "Mercedes"
};

export type TeamPrincipalDocument = F1ReferenceDocument & {
  constructorId?: string; // FK → f1_constructors (current role)
  startDate?: string;
  endDate?: string;
};

export type CircuitDocument = F1ReferenceDocument & {
  country?: string;
  city?: string;
  lapLengthKm?: number;
  numberOfLaps?: number;
};

export type SeasonDocument = F1ReferenceDocument & {
  year?: number; // the identifying quantitative field
  driverChampionId?: string; // FK → f1_drivers
  constructorChampionId?: string; // FK → f1_constructors
};

/** Time-bounded driver × constructor × season membership. */
export type DriverSeatDocument = F1BaseDocument & {
  driverId: string; // FK → f1_drivers
  constructorId: string; // FK → f1_constructors
  seasonId?: string; // FK → f1_seasons
  startDate?: string; // ISO
  endDate?: string; // ISO
  isReserveOrTest?: boolean;
};

export type GrandPrixDocument = F1ReferenceDocument & {
  seasonId?: string; // FK → f1_seasons
  circuitId?: string; // FK → f1_circuits
  date?: string; // ISO date
  round?: number; // round number within the season
  isSprintWeekend?: boolean;
};

// ---------------------------------------------------------------------------
// Tier 2 — results (numeric-heavy quantitative query targets)
// ---------------------------------------------------------------------------

export type RaceResultStatus = "Finished" | "DNF" | "DSQ" | "DNS" | "Lapped";

export type RaceResultDocument = F1FactDocument & {
  driverId?: string; // FK → f1_drivers
  constructorId?: string; // FK → f1_constructors
  grandPrixId?: string; // FK → f1_grand_prix
  seasonId?: string; // denormalized for fast per-season queries
  position?: number; // 1..20, null if DNF/DSQ
  points?: number;
  gridPosition?: number;
  laps?: number; // laps completed
  status?: RaceResultStatus;
  raceTimeMs?: number; // total race time in milliseconds
  gapToWinnerMs?: number; // gap to P1 in milliseconds
  fastestLapTimeMs?: number; // driver's fastest lap in ms
  hadFastestLap?: boolean; // awarded fastest lap bonus
};

export type QualifyingResultDocument = F1FactDocument & {
  driverId?: string;
  constructorId?: string;
  grandPrixId?: string;
  seasonId?: string;
  gridPosition?: number; // final qualifying position (1..20)
  q1Ms?: number; // best Q1 lap in milliseconds
  q2Ms?: number;
  q3Ms?: number;
  knockedOutIn?: "Q1" | "Q2" | "Q3";
};

export type SprintResultStatus = "Finished" | "DNF" | "DSQ" | "DNS";

export type SprintResultDocument = F1FactDocument & {
  driverId?: string;
  constructorId?: string;
  grandPrixId?: string;
  seasonId?: string;
  position?: number;
  points?: number; // sprint scoring differs from main race
  gridPosition?: number;
  status?: SprintResultStatus;
};

export type PitStopDocument = F1FactDocument & {
  driverId?: string;
  constructorId?: string;
  grandPrixId?: string;
  seasonId?: string;
  stopNumber?: number; // 1st, 2nd, 3rd stop of the race
  lap?: number;
  durationMs?: number; // stationary time in milliseconds
  tyreCompoundFrom?: string;
  tyreCompoundTo?: string;
};

// ---------------------------------------------------------------------------
// Tier 3 — regulatory
// ---------------------------------------------------------------------------

export type IncidentType =
  | "Collision"
  | "Spin"
  | "Mechanical"
  | "OffTrack"
  | "Other";

export type IncidentDocument = F1FactDocument & {
  driverIds?: string[]; // FK[] → f1_drivers
  grandPrixId?: string;
  seasonId?: string;
  lap?: number;
  incidentType?: IncidentType;
  description?: string;
  causedSafetyCar?: boolean;
  causedVirtualSafetyCar?: boolean;
  causedRedFlag?: boolean;
};

export type PenaltyType =
  | "TimePenalty"
  | "GridPenalty"
  | "PointsDeduction"
  | "Reprimand"
  | "Fine"
  | "Disqualification";

export type PenaltyUnit =
  | "seconds"
  | "grid_positions"
  | "points"
  | "eur"
  | "usd"
  | "none";

export type PenaltyDocument = F1FactDocument & {
  recipientId?: string; // FK → f1_drivers or f1_constructors
  recipientType?: "Driver" | "Constructor";
  grandPrixId?: string;
  seasonId?: string;
  penaltyType?: PenaltyType;
  value?: number; // 5 (seconds), 3 (grid places), 100000 (fine amount)
  unit?: PenaltyUnit;
  reason?: string;
  relatedIncidentId?: string; // FK → f1_incidents
};

// ---------------------------------------------------------------------------
// Tier 4 — contextual
// ---------------------------------------------------------------------------

export type CarDocument = F1FactDocument & {
  constructorId?: string;
  seasonId?: string;
  designation?: string; // e.g. "RB20", "W15"
};

export type TyreCompound = "Soft" | "Medium" | "Hard" | "Intermediate" | "Wet";

export type TyreCompoundDocument = F1FactDocument & {
  compound?: TyreCompound;
  supplier?: string;
};

export type QuoteSpeakerType =
  | "Driver"
  | "TeamPrincipal"
  | "Official"
  | "Engineer"
  | "Other";

export type QuoteDocument = F1FactDocument & {
  speakerId?: string; // FK → f1_drivers or f1_team_principals
  speakerType?: QuoteSpeakerType;
  grandPrixId?: string;
  context?: string; // e.g. "post-race interview"
  text: string; // the actual quote — required
};

export type TransferRumourStatus = "Rumour" | "Reported" | "Confirmed";

export type TransferRumourDocument = F1FactDocument & {
  driverId?: string;
  fromConstructorId?: string;
  toConstructorId?: string;
  targetSeasonId?: string;
  reportedDate?: string; // ISO
  reportedStatus?: TransferRumourStatus;
};

// ---------------------------------------------------------------------------
// Collection name map — single source of truth
// ---------------------------------------------------------------------------

export const F1_COLL = {
  drivers: "f1_drivers",
  constructors: "f1_constructors",
  teamPrincipals: "f1_team_principals",
  circuits: "f1_circuits",
  seasons: "f1_seasons",
  driverSeats: "f1_driver_seats",
  grandsPrix: "f1_grand_prix",
  raceResults: "f1_race_results",
  qualifyingResults: "f1_qualifying_results",
  sprintResults: "f1_sprint_results",
  pitStops: "f1_pit_stops",
  incidents: "f1_incidents",
  penalties: "f1_penalties",
  cars: "f1_cars",
  tyreCompounds: "f1_tyre_compounds",
  quotes: "f1_quotes",
  transferRumours: "f1_transfer_rumours",
} as const;

export type F1CollectionKey = keyof typeof F1_COLL;
export type F1CollectionName = (typeof F1_COLL)[F1CollectionKey];

/** Collections that are "reference entities" (carry aliases). */
export const F1_REFERENCE_COLLECTIONS: readonly F1CollectionName[] = [
  F1_COLL.drivers,
  F1_COLL.constructors,
  F1_COLL.teamPrincipals,
  F1_COLL.circuits,
  F1_COLL.seasons,
  F1_COLL.grandsPrix,
] as const;

/** Collections that are "fact documents" (carry provenance). */
export const F1_FACT_COLLECTIONS: readonly F1CollectionName[] = [
  F1_COLL.raceResults,
  F1_COLL.qualifyingResults,
  F1_COLL.sprintResults,
  F1_COLL.pitStops,
  F1_COLL.incidents,
  F1_COLL.penalties,
  F1_COLL.cars,
  F1_COLL.tyreCompounds,
  F1_COLL.quotes,
  F1_COLL.transferRumours,
] as const;
