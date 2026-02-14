import { nanoid } from "nanoid";

const adjectives = [
  "Rosso",
  "Velvet",
  "Carbon",
  "GranTurismo",
  "Apex",
  "Veloce",
  "Corsa",
  "Titan",
  "Obsidian",
  "Marble",
  "Noir",
  "Silver",
  "Scarlet",
  "Graphite",
  "Prismatic",
];

const nouns = [
  "Studio",
  "Archive",
  "Atelier",
  "Foundry",
  "Garage",
  "Workshop",
  "Lab",
  "Vault",
  "Library",
  "Index",
  "Chronicle",
];

export function createRandomOrgName(): string {
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)]!;
  const noun = nouns[Math.floor(Math.random() * nouns.length)]!;
  const suffix = nanoid(6).toUpperCase();
  return `${adj} ${noun} ${suffix}`;
}

