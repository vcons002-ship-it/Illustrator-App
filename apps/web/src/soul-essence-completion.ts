import {
  parseGeneratedSoulEssence,
  parseSoulEssenceMerge,
  soulEssenceJsonSchema,
  soulEssenceMergeRepairFeedback,
  soulEssenceRepairFeedback,
  soulNoteSources,
  supportsChat,
  type LLMProvider,
  type SoulEssence,
  type SoulEssenceDigestInput,
  type SoulEssenceDistillationPrompt,
  type SoulKind,
  type SoulNote,
} from "@visual-reader/core";

export interface SoulEssenceCompletionFailure {
  feedback: string;
  truncated: boolean;
}

export interface SoulEssenceCompletionResult {
  essence?: SoulEssence;
  failure?: SoulEssenceCompletionFailure;
}

export interface CompleteSoulEssenceOptions {
  llm: LLMProvider;
  kind: SoulKind;
  notes: readonly SoulNote[];
  prompt: SoulEssenceDistillationPrompt;
  maxTokens: number;
  signal?: AbortSignal;
  digests?: readonly SoulEssenceDigestInput[];
  onToken?: (delta: string) => void;
  onRepair?: (feedback: string, truncated: boolean) => void;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("Aborted");
  error.name = "AbortError";
  throw error;
}

/**
 * Run a grounded Soul completion and one INFORMED repair.
 *
 * The old retry repeated the same temperature-zero request with only “try again”, so a local model
 * predictably repeated the same uncited source. This coordinator is separate from the worker so the
 * exact retry contract is regression-testable: it carries provider truncation metadata, repairs
 * safely closable JSON before retrying, and tells pass two the precise semantic rule/source IDs that
 * failed.
 */
export async function completeSoulEssenceWithRepair(
  opts: CompleteSoulEssenceOptions,
): Promise<SoulEssenceCompletionResult> {
  if (!supportsChat(opts.llm)) {
    return {
      failure: {
        feedback: "The selected text provider does not support chat completions.",
        truncated: false,
      },
    };
  }

  let feedback = "";
  let wasTruncated = false;
  const sourceIds = soulNoteSources(opts.notes).map((source) => source.id);
  for (let attempt = 0; attempt < 2; attempt++) {
    throwIfAborted(opts.signal);
    if (attempt > 0) opts.onRepair?.(feedback, wasTruncated);
    const repairBlock =
      attempt === 0
        ? ""
        : [
            "",
            "REPAIR ATTEMPT: The prior response reached the app but failed grounded validation.",
            wasTruncated
              ? "The provider also reported that the response hit its output limit. Use shorter facet text so the complete JSON object fits."
              : "",
            "Correct these exact problems:",
            feedback,
            "Return one complete JSON object only. Use only supplied valid IDs, and do not leave any listed ordinary source uncovered.",
          ]
            .filter(Boolean)
            .join("\n");
    let truncated = false;
    const raw = await opts.llm.chat(
      [
        { role: "system", content: `${opts.prompt.system}${repairBlock}` },
        { role: "user", content: opts.prompt.user },
      ],
      {
        maxTokens: opts.maxTokens,
        reasoningEffort: "none",
        responseFormat: "json",
        jsonSchema: soulEssenceJsonSchema(
          opts.kind,
          opts.prompt.sourceFingerprint,
          opts.digests ? [] : sourceIds,
        ),
        onComplete: (meta) => {
          truncated = meta.truncated;
        },
        ...(opts.onToken ? { onToken: opts.onToken } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
    );
    throwIfAborted(opts.signal);
    const essence = opts.digests
      ? parseSoulEssenceMerge(raw, opts.kind, opts.notes, opts.digests, Date.now())
      : parseGeneratedSoulEssence(raw, opts.kind, opts.notes, Date.now());
    if (essence) return { essence };

    wasTruncated = truncated;
    const semanticFeedback = opts.digests
      ? soulEssenceMergeRepairFeedback(raw, opts.kind, opts.notes, opts.digests)
      : soulEssenceRepairFeedback(raw, opts.kind, opts.notes);
    feedback = [
      ...(truncated
        ? ["The response ended at the provider's output-token limit before validation completed."]
        : []),
      semanticFeedback,
    ]
      .filter(Boolean)
      .join("\n");
  }

  return {
    failure: {
      feedback:
        feedback ||
        "The response did not satisfy the grounded Soul Essence format.",
      truncated: wasTruncated,
    },
  };
}
