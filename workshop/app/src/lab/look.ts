import { CircleHelp, Keyboard, MessageSquareQuote, User, Zap, type LucideIcon } from "lucide-react";
import type { Persona, Status } from "./types";

/** The two lines under the logo: what is being tested. */
export const AGENT_TITLE = "Агент эквайринга";
export const AGENT_SUBTITLE = "СберБизнес · чат поддержки";

export const DEFAULT_PERSONA = "default";
export const personaName = (personas: Persona[], id?: string) => personas.find(p => p.id === (id ?? DEFAULT_PERSONA))?.name ?? id ?? "";
