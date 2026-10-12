export type HealthResponse = {
  ok: boolean;
  service: string;
  offlineReady: boolean;
  db?: { driver: string; path: string; questions: number };
  ollama: {
    reachable: boolean;
    model: string;
    modelAvailable: boolean;
    baseUrl: string;
    pullHint: string;
    detail?: string;
  };
};

export type PublicQuestion = {
  id: string;
  module: number;
  topic: string;
  conceptTags: string[];
  type: "multiple_choice" | "procedural" | "identification" | "situational";
  difficulty: number;
  prompt: string;
  source: string;
  sourceRef: { file: string; heading: string };
  sourceBreadcrumb: string;
  needsReview: boolean;
  outdatedNote?: string;
  aiGenerated?: boolean;
  options?: string[];
  selectionMode?: "radio" | "checkbox";
  chooseHint?: string;
  correctCount?: number;
  isTrueFalse?: boolean;
  shuffledSteps?: string[];
  scenario?: string;
};

export type DiffSpan = { kind: "eq" | "del" | "ins"; text: string };

export type McOptionFeedback = {
  index: number;
  text: string;
  isCorrect: boolean;
  isSelected: boolean;
  mark: "correct" | "wrong_pick" | "missed" | "neutral";
};

export type GradeFeedback =
  | {
      kind: "multiple_choice";
      resultLine: string;
      yourAnswer: string[];
      correctAnswer: string[];
      options: McOptionFeedback[];
      explanation: string;
      sourceBreadcrumb: string;
    }
  | {
      kind: "identification";
      resultLine: string;
      yourAnswer: string;
      correctAnswer: string;
      diff: DiffSpan[];
      spellingNote?: string;
      aiNote?: string;
      explanation: string;
      sourceBreadcrumb: string;
    }
  | {
      kind: "procedural";
      resultLine: string;
      yourOrder: Array<{ step: string; outOfPlace: boolean }>;
      correctOrder: Array<{ step: string; outOfPlace: boolean }>;
      explanation: string;
      sourceBreadcrumb: string;
    }
  | {
      kind: "situational";
      resultLine: string;
      score: number;
      keyPointsHit: string[];
      keyPointsMissed: string[];
      feedback: string;
      modelAnswer: string;
      explanation: string;
      sourceBreadcrumb: string;
    };

export type GradeResponse = {
  score: number;
  attemptId: number;
  feedback: GradeFeedback;
};
