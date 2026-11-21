import { NextResponse } from 'next/server';
import { z } from 'zod';

const AssistantRequestSchema = z.object({
  message: z.string().min(1).max(1200),
  history: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        text: z.string().min(1).max(1400),
      })
    )
    .max(10)
    .optional(),
  context: z
    .object({
      view: z.enum(['CHECKUP', 'REPORT', 'EXPERT']).optional(),
      selectedStandard: z
        .enum(['ISO_9001', 'ISO_14001', 'ISO_45001', 'ISO_IEC_17024', 'INTEGRATED'])
        .optional(),
      sector: z.string().max(120).optional(),
      staffRange: z.string().max(60).optional(),
      ruleScorePct: z.number().min(0).max(100).optional(),
      topGaps: z.array(z.string().max(160)).max(6).optional(),
    })
    .optional(),
});

export const SecretaryReplySchema = z.object({
  replyText: z.string().min(8).max(1400),
  nextStepHint: z.string().min(4).max(300),
  suggestedAction: z
    .object({
      label: z.string().min(2).max(50),
      targetView: z.enum(['CHECKUP', 'REPORT', 'EXPERT']),
      standardCode: z
        .enum(['ISO_9001', 'ISO_14001', 'ISO_45001', 'ISO_IEC_17024', 'INTEGRATED'])
        .optional(),
    })
    .optional(),
});

function buildFallbackReply(message: string, context?: z.infer<typeof AssistantRequestSchema>['context']) {
  const std = context?.selectedStandard ?? 'ISO_9001';
  return {
    model: 'iso-secretary-fallback-v1',
    replyText:
      `Ön bilgilendirme notu: "${message.slice(0, 120)}" sorunuz için ${std} kapsamında mevcut durumunuzu netleştirip uzman onaylı ön değerlendirme adımlarını planlayabiliriz. Belgelendirme kararı bağımsız belgelendirme kuruluşu denetimine bağlıdır.`,
    nextStepHint: 'Check-Up sorularını tamamlayıp uzman incelemesine (PENDING_REVIEW) gönderin.',
    suggestedAction: {
      label: 'Check-Up Başlat',
      targetView: context?.view ?? 'CHECKUP',
      standardCode: std,
    },
  };
}

export async function POST(req: Request) {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: 'Geçersiz JSON gövdesi' }, { status: 400 });
  }

  const parsedInput = AssistantRequestSchema.safeParse(raw);
  if (!parsedInput.success) {
    return NextResponse.json(
      { error: 'Geçersiz istek verisi', details: parsedInput.error.flatten() },
      { status: 400 }
    );
  }

  const { message, history = [], context } = parsedInput.data;
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  const model = process.env.GEMINI_MODEL?.trim() || 'gemini-2.5-flash';
  const timeoutMs = Number(process.env.GEMINI_TIMEOUT_MS || 14000);

  if (!apiKey) {
    return NextResponse.json(buildFallbackReply(message, context));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      model
    )}:generateContent`;

    const systemInstruction =
      'Sen DM ISO 360 sekreter-danışman asistanısın. Kibar, net ve yönlendirici Türkçe konuş. ' +
      'Kesin belgelendirme garantisi verme; skorun kural motorunda sabit kaldığını ve nihai değerlendirmenin uzman onayına tabi olduğunu belirt. ' +
      'Kişisel iletişim bilgisi isteme veya üretme.';

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      signal: controller.signal,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents: [
          {
            role: 'user',
            parts: [{ text: JSON.stringify({ message, history: history.slice(-6), context }) }],
          },
        ],
        generationConfig: {
          temperature: 0.35,
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'OBJECT',
            required: ['replyText', 'nextStepHint'],
            properties: {
              replyText: { type: 'STRING' },
              nextStepHint: { type: 'STRING' },
              suggestedAction: {
                type: 'OBJECT',
                required: ['label', 'targetView'],
                properties: {
                  label: { type: 'STRING' },
                  targetView: { type: 'STRING', enum: ['CHECKUP', 'REPORT', 'EXPERT'] },
                  standardCode: {
                    type: 'STRING',
                    enum: ['ISO_9001', 'ISO_14001', 'ISO_45001', 'ISO_IEC_17024', 'INTEGRATED'],
                  },
                },
              },
            },
          },
        },
      }),
    });

    if (!res.ok) {
      return NextResponse.json(buildFallbackReply(message, context));
    }

    const data = await res.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const cleaned = rawText
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    const parsedModel = SecretaryReplySchema.safeParse(JSON.parse(cleaned));
    if (!parsedModel.success) {
      return NextResponse.json(buildFallbackReply(message, context));
    }

    return NextResponse.json({
      model,
      ...parsedModel.data,
    });
  } catch {
    return NextResponse.json(buildFallbackReply(message, context));
  } finally {
    clearTimeout(timer);
  }
}
