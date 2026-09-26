export type TypesafeQuestion =
  | {
      type: "choice";
      instructions: string;
      criteria: Record<string, string | null>;
    }
  | {
      type: "score";
      instructions: string;
      criteria: string[];
    }
  | {
      type: "noul";
      instructions: string;
      criteria?: { true: string; false: string };
    };

export interface TypesafeRequest {
  state: Record<string, unknown>;
  model: string;
  questions: Record<string, TypesafeQuestion>;
}

export type TypesafeAnswer =
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: "score"; score: number; legend: Record<string, string>; probabilities: Record<string, number>; confidence: number }
  | { type: "noul"; noul: number };

export interface TypesafeResponse {
  model: string;
  answers: Record<string, TypesafeAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
}
