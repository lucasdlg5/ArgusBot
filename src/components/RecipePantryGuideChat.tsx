'use client';

import React, { useRef, useState } from 'react';
import {
  ArrowRight,
  Bot,
  CheckCircle2,
  ChefHat,
  Refrigerator,
  Send,
  Sparkles,
  X
} from 'lucide-react';
import {
  buildDeterministicGuideReply,
  type PantryRecipeMatch
} from '@/lib/pantry-matcher';
import { resolvePublicApiUrl } from '@/lib/public-bi-client';
import type { RecipeCostEvaluation } from '@/types/argus';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  usedAi?: boolean;
  matches?: PantryRecipeMatch[];
}

interface RecipePantryGuideChatProps {
  recipes: RecipeCostEvaluation[];
  onSelectRecipe: (recipeId: string) => void;
  onClose?: () => void;
}

const EXAMPLE_PROMPTS = [
  'Tenho 1kg de frango, creme de leite, ketchup e batata palha',
  'Quero usar 500g de frango congelado junto com restinho de molho madeira',
  'Tenho 1 pepino grande, 100g de queijo e alho'
];

export default function RecipePantryGuideChat({
  recipes,
  onSelectRecipe,
  onClose
}: RecipePantryGuideChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'welcome',
      role: 'assistant',
      text:
        recipes.length > 0
          ? `Olá! Me diga o que você tem na geladeira ou despensa (pode incluir medidas como "500g de frango", "1 pepino grande", "restinho de molho madeira"). Vou buscar a maior semelhança entre suas **${recipes.length} receita(s) cadastrada(s)**!`
          : 'Olá! Ainda não há receitas cadastradas na sua base local. Assim que você cadastrar receitas, posso cruzar os ingredientes da sua geladeira com elas!'
    }
  ]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);

  const sendPrompt = async (promptText: string) => {
    const clean = promptText.trim();
    if (!clean || sending) return;

    const userMsg: ChatMessage = {
      id: `u-${Date.now()}`,
      role: 'user',
      text: clean
    };
    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setSending(true);

    setTimeout(() => endRef.current?.scrollIntoView({ behavior: 'smooth' }), 50);

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 11000);
      const res = await fetch(resolvePublicApiUrl('/api/recipes/pantry-chat'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({ message: clean, recipes })
      });
      clearTimeout(timer);

      if (res.ok) {
        const json = (await res.json()) as {
          replyText: string;
          usedAi?: boolean;
          matches?: PantryRecipeMatch[];
        };
        setMessages((prev) => [
          ...prev,
          {
            id: `a-${Date.now()}`,
            role: 'assistant',
            text: json.replyText,
            usedAi: json.usedAi,
            matches: json.matches || []
          }
        ]);
        return;
      }
      throw new Error('Fallback local');
    } catch {
      const fallback = buildDeterministicGuideReply(clean, recipes);
      setMessages((prev) => [
        ...prev,
        {
          id: `a-${Date.now()}`,
          role: 'assistant',
          text: fallback.replyText,
          usedAi: false,
          matches: fallback.matches
        }
      ]);
    } finally {
      setSending(false);
      setTimeout(() => endRef.current?.scrollIntoView({ behavior: 'smooth' }), 80);
    }
  };

  return (
    <section className="rounded-2xl border border-emerald-500/30 bg-slate-900/80 shadow-xl overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 bg-slate-950/70 px-5 py-3.5">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-300">
            <Refrigerator className="h-4 w-4" />
          </div>
          <div>
            <h2 className="text-sm font-bold text-white flex items-center gap-2">
              Guia da Geladeira &amp; Despensa
              <span className="rounded-full border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-[10px] font-medium text-sky-300">
                Base Local ({recipes.length} receitas)
              </span>
            </h2>
            <p className="text-[11px] text-slate-400">
              Diga ingredientes, medidas ou vontades — encontro a receita cadastrada mais compatível e o que falta comprar.
            </p>
          </div>
        </div>

        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white transition-colors"
            aria-label="Fechar Guia da Geladeira"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* Exemplos rápidos */}
      <div className="flex flex-wrap items-center gap-1.5 border-b border-slate-800/70 bg-slate-950/30 px-5 py-2.5">
        <span className="text-[10px] uppercase tracking-wider text-slate-500 mr-1">Exemplos:</span>
        {EXAMPLE_PROMPTS.map((ex) => (
          <button
            key={ex}
            type="button"
            disabled={sending}
            onClick={() => sendPrompt(ex)}
            className="rounded-full border border-slate-700/80 bg-slate-900 hover:border-emerald-500/50 hover:text-emerald-200 px-2.5 py-1 text-[11px] text-slate-300 transition-colors text-left"
          >
            “{ex}”
          </button>
        ))}
      </div>

      {/* Histórico do Chat */}
      <div className="max-h-[420px] overflow-y-auto px-5 py-4 space-y-4">
        {messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}
          >
            <div
              className={`max-w-[92%] md:max-w-[82%] rounded-2xl px-4 py-3 text-xs leading-relaxed ${
                msg.role === 'user'
                  ? 'bg-emerald-500 text-slate-950 font-medium'
                  : 'border border-slate-800 bg-slate-950/80 text-slate-200'
              }`}
            >
              {msg.role === 'assistant' && (
                <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-400">
                  {msg.usedAi ? <Sparkles className="h-3 w-3" /> : <Bot className="h-3 w-3" />}
                  <span>{msg.usedAi ? 'Guia IA + Base Local' : 'Guia Local Argus'}</span>
                </div>
              )}
              <p className="whitespace-pre-line">{msg.text.replace(/\*\*/g, '')}</p>
            </div>

            {/* Cards das receitas compatíveis */}
            {msg.role === 'assistant' && msg.matches && msg.matches.length > 0 && (
              <div className="mt-2.5 grid grid-cols-1 md:grid-cols-2 gap-3 w-full max-w-[96%]">
                {msg.matches.map((m) => (
                  <div
                    key={m.recipe.recipeId}
                    className="rounded-xl border border-slate-800 bg-slate-950/90 p-3.5 space-y-2.5"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <h3 className="text-xs font-bold text-white flex items-center gap-1.5">
                          <ChefHat className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                          {m.recipe.recipeName}
                        </h3>
                        <p className="text-[11px] text-slate-400 mt-0.5">
                          {m.matchedCount}/{m.totalIngredients} ingredientes compatíveis
                        </p>
                      </div>
                      <span className="rounded-full border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 text-[11px] font-bold text-emerald-300 shrink-0 tabular-nums">
                        {m.similarityPct}% match
                      </span>
                    </div>

                    <div className="space-y-1.5 text-[11px]">
                      <div className="flex flex-wrap gap-1">
                        {m.matchedIngredients.map((ing) => (
                          <span
                            key={ing.ingredientName}
                            title={ing.note}
                            className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 border ${
                              ing.sufficiency === 'PARTIAL'
                                ? 'border-amber-500/40 bg-amber-500/10 text-amber-200'
                                : 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
                            }`}
                          >
                            <CheckCircle2 className="h-3 w-3 shrink-0" />
                            <span>
                              {ing.ingredientName} ({ing.note})
                            </span>
                          </span>
                        ))}
                      </div>

                      {m.missingIngredients.length > 0 && (
                        <p className="text-slate-400">
                          <strong className="text-slate-300">Falta comprar:</strong>{' '}
                          {m.missingIngredients
                            .slice(0, 4)
                            .map((i) => i.productName)
                            .join(', ')}
                          {m.missingIngredients.length > 4
                            ? ` (+${m.missingIngredients.length - 4})`
                            : ''}
                        </p>
                      )}
                    </div>

                    <div className="flex items-center justify-between gap-2 pt-2 border-t border-slate-800/80">
                      <div className="text-[11px] tabular-nums">
                        <span className="text-slate-400">Falta gastar: </span>
                        <strong className="text-emerald-300">
                          R$ {m.missingEstimatedCost.toFixed(2)}
                        </strong>
                        {m.estimatedSavings > 0 && (
                          <span className="text-slate-500 ml-1.5">
                            (economiza R$ {m.estimatedSavings.toFixed(2)})
                          </span>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => onSelectRecipe(m.recipe.recipeId)}
                        className="inline-flex items-center gap-1 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/40 px-2.5 py-1 text-[11px] font-semibold text-emerald-200 transition-colors shrink-0"
                      >
                        Abrir Receita
                        <ArrowRight className="h-3 w-3" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}

        {sending && (
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <Bot className="h-4 w-4 text-emerald-400 animate-pulse" />
            <span>Comparando sua geladeira com as receitas locais...</span>
          </div>
        )}
        <div ref={endRef} />
      </div>

      {/* Input do Chat */}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          sendPrompt(input);
        }}
        className="flex items-center gap-2 border-t border-slate-800 bg-slate-950/70 px-4 py-3"
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ex: Tenho 500g de frango congelado, 1 pepino grande e restinho de molho madeira..."
          className="flex-1 rounded-xl border border-slate-700 bg-slate-900 px-3.5 py-2.5 text-xs text-white placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none"
        />
        <button
          type="submit"
          disabled={sending || !input.trim()}
          className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 px-4 py-2.5 text-xs font-semibold text-slate-950 transition-colors shrink-0"
        >
          <Send className="h-3.5 w-3.5" />
          Perguntar
        </button>
      </form>
    </section>
  );
}
