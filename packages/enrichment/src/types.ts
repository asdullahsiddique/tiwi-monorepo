import type {
  CarDocument,
  CircuitDocument,
  ConstructorDocument,
  DriverDocument,
  DriverSeatDocument,
  F1BaseDocument,
  FactProvenance,
  GrandPrixDocument,
  IncidentDocument,
  PenaltyDocument,
  PitStopDocument,
  QualifyingResultDocument,
  QuoteDocument,
  RaceResultDocument,
  SeasonDocument,
  SprintResultDocument,
  TeamPrincipalDocument,
  TransferRumourDocument,
  TyreCompoundDocument,
} from "@tiwi/mongodb";

// ---------------------------------------------------------------------------
// Shared cross-node logging types
// ---------------------------------------------------------------------------

export type AICallUsage = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  purpose: string;
  createdAtIso: string;
};

export type DecisionLog = {
  level: "INFO" | "WARN";
  message: string;
  createdAtIso: string;
  metadata?: Record<string, unknown>;
};

// ---------------------------------------------------------------------------
// Draft docs — what each extraction node emits
//
// A "draft" is the payload passed to F1Repository.upsertXxx after the graph
// finishes. Fields owned by the persistence layer (orgId, sourceFileIds,
// createdAt, updatedAt) are omitted; entityId is pre-generated so other nodes
// in the same run can reference it for FK lookups.
// ---------------------------------------------------------------------------

export type DraftDoc<T extends F1BaseDocument> = Omit<
  T,
  "orgId" | "sourceFileIds" | "createdAt" | "updatedAt" | "nameLower"
> & {
  entityId: string;
};

export type DraftDriver = DraftDoc<DriverDocument>;
export type DraftConstructor = DraftDoc<ConstructorDocument>;
export type DraftTeamPrincipal = DraftDoc<TeamPrincipalDocument>;
export type DraftCircuit = DraftDoc<CircuitDocument>;
export type DraftSeason = DraftDoc<SeasonDocument>;
export type DraftGrandPrix = DraftDoc<GrandPrixDocument>;
export type DraftDriverSeat = DraftDoc<DriverSeatDocument>;
export type DraftRaceResult = DraftDoc<RaceResultDocument>;
export type DraftQualifyingResult = DraftDoc<QualifyingResultDocument>;
export type DraftSprintResult = DraftDoc<SprintResultDocument>;
export type DraftPitStop = DraftDoc<PitStopDocument>;
export type DraftIncident = DraftDoc<IncidentDocument>;
export type DraftPenalty = DraftDoc<PenaltyDocument>;
export type DraftCar = DraftDoc<CarDocument>;
export type DraftTyreCompound = DraftDoc<TyreCompoundDocument>;
export type DraftQuote = DraftDoc<QuoteDocument>;
export type DraftTransferRumour = DraftDoc<TransferRumourDocument>;

// ---------------------------------------------------------------------------
// Final enrichment result returned to the daemon
// ---------------------------------------------------------------------------

export type F1EnrichmentResult = {
  drivers: DraftDriver[];
  constructors: DraftConstructor[];
  teamPrincipals: DraftTeamPrincipal[];
  circuits: DraftCircuit[];
  seasons: DraftSeason[];
  grandsPrix: DraftGrandPrix[];
  driverSeats: DraftDriverSeat[];
  raceResults: DraftRaceResult[];
  qualifyingResults: DraftQualifyingResult[];
  sprintResults: DraftSprintResult[];
  pitStops: DraftPitStop[];
  incidents: DraftIncident[];
  penalties: DraftPenalty[];
  cars: DraftCar[];
  tyreCompounds: DraftTyreCompound[];
  quotes: DraftQuote[];
  transferRumours: DraftTransferRumour[];

  decisions: DecisionLog[];
  aiCalls: AICallUsage[];
  errors: string[];
};

// Re-export FactProvenance for convenience.
export type { FactProvenance };
