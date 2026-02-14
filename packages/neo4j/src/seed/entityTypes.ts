import { TypeRegistryRepository } from "../repositories/typeRegistryRepo";

/**
 * Built-in entity types for the knowledge graph.
 * These provide a foundation for AI entity extraction.
 */
export const BUILT_IN_ENTITY_TYPES = [
  // People and Organizations
  {
    typeName: "Person",
    description: "An individual person. Use for names, contacts, authors, speakers, etc.",
  },
  {
    typeName: "Organization",
    description: "A company, business, team, group, or any formal organization.",
  },
  {
    typeName: "Team",
    description: "A group of people working together within an organization.",
  },

  // Documents and Business
  {
    typeName: "Invoice",
    description: "A financial document requesting payment for goods or services.",
  },
  {
    typeName: "Contract",
    description: "A legal agreement between parties.",
  },
  {
    typeName: "Document",
    description: "A general document, report, or file reference.",
  },
  {
    typeName: "Project",
    description: "A planned undertaking or initiative with specific goals.",
  },
  {
    typeName: "Meeting",
    description: "A gathering or session where people discuss topics.",
  },

  // Financial
  {
    typeName: "Money",
    description: "A monetary amount with currency. Use for prices, costs, payments, etc.",
  },
  {
    typeName: "Payment",
    description: "A transfer of money from one party to another.",
  },
  {
    typeName: "Account",
    description: "A financial account (bank account, credit account, etc.).",
  },

  // Time and Location
  {
    typeName: "Date",
    description: "A specific calendar date or date range.",
  },
  {
    typeName: "Duration",
    description: "A period of time (e.g., 2 weeks, 3 months).",
  },
  {
    typeName: "Location",
    description: "A physical place, address, city, country, or geographic reference.",
  },

  // Products and Services
  {
    typeName: "Product",
    description: "A physical or digital product that can be sold or used.",
  },
  {
    typeName: "Service",
    description: "A service offering or work performed for others.",
  },

  // Technical
  {
    typeName: "Technology",
    description: "A technology, software, tool, or technical system.",
  },
  {
    typeName: "API",
    description: "An application programming interface or endpoint.",
  },

  // Communication
  {
    typeName: "Email",
    description: "An email message or email address.",
  },
  {
    typeName: "PhoneNumber",
    description: "A telephone number.",
  },
  {
    typeName: "URL",
    description: "A web address or link.",
  },

  // Events
  {
    typeName: "Event",
    description: "A scheduled or notable occurrence (conference, launch, etc.).",
  },
  {
    typeName: "Task",
    description: "An action item or task to be completed.",
  },
  {
    typeName: "Deadline",
    description: "A date by which something must be completed.",
  },

  // Knowledge
  {
    typeName: "Topic",
    description: "A subject, theme, or area of knowledge.",
  },
  {
    typeName: "Quote",
    description: "A notable statement or quotation from someone.",
  },
  {
    typeName: "Concept",
    description: "An abstract idea or general notion.",
  },
] as const;

/**
 * Seed built-in entity types for an organization.
 * Safe to call multiple times (idempotent via MERGE).
 */
export async function seedEntityTypes(params: {
  typeRegistryRepo: TypeRegistryRepository;
  orgId: string;
}): Promise<void> {
  const { typeRegistryRepo, orgId } = params;

  for (const type of BUILT_IN_ENTITY_TYPES) {
    await typeRegistryRepo.createType({
      orgId,
      typeName: type.typeName,
      description: type.description,
      createdBy: "system",
      isBuiltIn: true,
    });
  }
}

/**
 * Get entity types formatted for AI prompts.
 */
export function formatTypesForPrompt(
  types: Array<{ typeName: string; description: string }>
): string {
  return types
    .map((t) => `- ${t.typeName}: ${t.description}`)
    .join("\n");
}
