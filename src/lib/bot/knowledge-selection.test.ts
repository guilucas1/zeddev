/**
 * Which knowledge one prompt carries. Pure, so no database.
 *
 * The rankings below use the way customers really write (no accents, typos,
 * inflected verbs, a follow-up that names no topic) against a business's own
 * phrasing, because that gap is what selection can get wrong, and getting it wrong
 * means a true fact never reaches the model. Budgets are set so only a few of the
 * entries fit: a generous budget would pass with any ranking at all.
 */

import assert from 'node:assert/strict';
import type { ConversationTurn } from '@zeddev/ai';
import { specTest, unitTest } from '@zeddev/testing';
import { KNOWLEDGE_LIMITS, knowledgeDirectives, type KnowledgeConfiguration, type KnowledgeEntry } from './knowledge.ts';
import { KNOWLEDGE_SELECTION, selectKnowledge } from './knowledge-selection.ts';
import { characters } from './shared.ts';

const SPEC = 'business-knowledge-configuration.md';
const NOW = new Date('2026-11-09T12:00:00Z');

function entry(content: string, index: number): KnowledgeEntry {
  return { id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, content, createdAt: NOW, updatedAt: NOW };
}

function knowledge(contents: readonly string[]): KnowledgeConfiguration {
  return { entries: contents.map(entry) };
}

function asked(text: string): ConversationTurn[] {
  return [{ role: 'customer', parts: [{ type: 'text', text }] }];
}

function contentsOf(selection: KnowledgeConfiguration): string[] {
  return selection.entries.map((item) => item.content);
}

function sizeOf(selection: KnowledgeConfiguration): number {
  return selection.entries.reduce((sum, item) => sum + characters(item.content), 0);
}

const LOJA = [
  'Horário de funcionamento: segunda a sexta das 9h às 18h, sábado das 9h às 13h.',
  'Entregamos em toda a cidade, e o frete é grátis para pedidos acima de R$ 150.',
  'Aceitamos Pix, cartão de crédito em até 3 vezes e dinheiro na retirada.',
  'Trocas e devoluções em até 30 dias, apresentando a nota fiscal.',
  'A garantia dos aparelhos é de 12 meses contra defeitos de fabricação.',
  'Estacionamento gratuito para clientes nos fundos da loja.',
  'Bolos personalizados precisam de 48 horas de antecedência.',
  'Temos opções sem glúten e sem lactose na vitrine refrigerada.',
  'Alugamos o salão de festas para aniversários de até 40 pessoas.',
  'O programa de fidelidade dá um café grátis a cada dez compras.',
  'Consertamos telas quebradas de celular no mesmo dia.',
  'Vagas de emprego são divulgadas no nosso perfil do Instagram.',
];

const SHOP = [
  'Opening hours are Monday to Friday, 9am to 6pm, and closed on public holidays.',
  'Delivery is free within 10km of the store and takes two working days.',
  'We take card, cash and bank transfer, but not cheques.',
  'Refunds are issued to the original payment method within 14 days of a return.',
  'Every appliance comes with a two year manufacturer warranty.',
  'Parking is free behind the building after 5pm.',
  'Gift cards are sold in store from 10 to 500 pounds and never expire.',
  'Wedding cakes need three weeks notice and a 20 percent deposit.',
  'Dogs are welcome on the terrace but not inside the cafe.',
  'Our loyalty scheme gives one free coffee for every ten bought.',
  'Screen repairs for phones are finished the same afternoon.',
  'Job openings are posted on our careers page every month.',
];

/** Room for about three of these short entries out of twelve. */
const TIGHT = 240;

for (const [corpus, cases] of [
  [
    LOJA,
    [
      ['vcs entregam no meu bairro?', 'Entregamos'],
      ['qual o horario de sabado', 'Horário de funcionamento'],
      ['posso pagar no pix?', 'Pix'],
      ['quero devolver uma compra', 'devoluções'],
      ['tem garantai o aparelho?', 'garantia'],
      ['onde eu estaciono o carro', 'Estacionamento'],
      ['vocês têm algo sem gluten?', 'glúten'],
    ],
  ],
  [
    SHOP,
    [
      ['do you deliver?', 'Delivery'],
      ['what time do you open', 'Opening hours'],
      ['can i pay by cheque', 'cheques'],
      ['how do I get a refund', 'Refunds'],
      ['is there a waranty on this fridge', 'warranty'],
      ['can i bring my dog', 'Dogs'],
      ['do you sell giftcards', 'Gift cards'],
    ],
  ],
] as const) {
  for (const [question, expected] of cases) {
    specTest(
      SPEC,
      'AC6 a configured fact reaches the reply that answers about it',
      `over budget, "${question}" still selects the entry holding the answer`,
      () => {
        const selection = selectKnowledge(knowledge(corpus), asked(question), TIGHT);
        assert.ok(
          contentsOf(selection).some((content) => content.includes(expected)),
          `got: ${JSON.stringify(contentsOf(selection))}`,
        );
      },
    );
  }
}

specTest(
  SPEC,
  'AC5 the response draws on configured knowledge',
  'knowledge that fits the budget is passed through whole and unmarked, so nothing can be lost',
  () => {
    const whole = knowledge(LOJA);
    const selection = selectKnowledge(whole, asked('oi'));
    assert.equal(selection, whole);
    assert.equal(selection.partial, undefined);
    assert.doesNotMatch(knowledgeDirectives(selection)!, /only the facts most relevant/);
    for (const content of LOJA) assert.ok(knowledgeDirectives(selection)!.includes(JSON.stringify(content)));
  },
);

unitTest('accents and case do not matter, however the keyboard encoded them', () => {
  // Room for either entry but not both, with the one that should win listed last.
  const corpus = ['Temos salgados assados.', 'Servimos açaí na tigela.'];
  for (const question of ['tem acai?', 'TEM AÇAÍ?', 'tem açaí?'.normalize('NFD')]) {
    assert.deepEqual(contentsOf(selectKnowledge(knowledge(corpus), asked(question), 24)), [corpus[1]], question);
  }
});

unitTest('the budget is exact: knowledge of precisely that size is not a selection', () => {
  const whole = knowledge(['a'.repeat(50), 'b'.repeat(50)]);
  assert.equal(selectKnowledge(whole, asked('oi'), 100), whole);
  assert.equal(selectKnowledge(whole, asked('oi'), 99).partial, true);
});

unitTest('the budget counts characters as the entry limit does, so an emoji costs one', () => {
  const whole = knowledge(['😀'.repeat(50), '😀'.repeat(50)]);
  assert.equal(selectKnowledge(whole, asked('oi'), 100), whole);
});

unitTest('a selection stays within budget, holds entries whole, and keeps their configured order', () => {
  const selection = selectKnowledge(knowledge(SHOP), asked('parking and delivery and refunds'), TIGHT);
  assert.equal(selection.partial, true);
  assert.ok(sizeOf(selection) <= TIGHT);
  assert.ok(selection.entries.length >= 2);
  const positions = contentsOf(selection).map((content) => SHOP.indexOf(content as (typeof SHOP)[number]));
  assert.ok(positions.every((position) => position !== -1), 'every selected entry is one configured entry, unaltered');
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
});

unitTest('an entry too big for what is left is passed over for a smaller one further down', () => {
  const selection = selectKnowledge(
    knowledge(['delivery delivery delivery', 'delivery rates vary by district and season', 'unrelated note']),
    asked('delivery'),
    42,
  );
  assert.deepEqual(contentsOf(selection), ['delivery delivery delivery', 'unrelated note']);
});

unitTest('the entry-size limit fits the budget, so the most relevant entry can always be carried', () => {
  assert.ok(KNOWLEDGE_SELECTION.promptBudget >= KNOWLEDGE_LIMITS.entryMaxLength);
});

unitTest('a tenant at the limits stays within the prompt budget and still finds the fact', () => {
  const filler = 'lorem ipsum dolor sit amet consectetur adipiscing elit '.repeat(80).slice(0, KNOWLEDGE_LIMITS.entryMaxLength).trim();
  const fact = `${'sed do eiusmod tempor incididunt '.repeat(100)}Refunds take fourteen days.`.slice(-KNOWLEDGE_LIMITS.entryMaxLength).trim();
  const contents = Array.from({ length: KNOWLEDGE_LIMITS.maxEntries }, () => filler);
  contents[73] = fact;
  const selection = selectKnowledge(knowledge(contents), asked('how long do refunds take?'));
  assert.ok(sizeOf(selection) <= KNOWLEDGE_SELECTION.promptBudget);
  assert.ok(contentsOf(selection).includes(fact));
});

specTest(
  SPEC,
  'AC6 a configured fact reaches the reply that answers about it',
  'a follow-up that names no topic is answered from what the conversation is about',
  () => {
    const turns: ConversationTurn[] = [
      { role: 'customer', parts: [{ type: 'text', text: 'quanto tempo de garantia tem o aparelho?' }] },
      { role: 'bot', text: 'A garantia do aparelho é de 12 meses.' },
      { role: 'customer', parts: [{ type: 'text', text: 'e cobre o quê?' }] },
    ];
    assert.ok(contentsOf(selectKnowledge(knowledge(LOJA), turns, TIGHT)).some((content) => content.includes('garantia')));
  },
);

specTest(
  SPEC,
  'AC6 a configured fact reaches the reply that answers about it',
  'what a photo showed counts as the question, and the platform’s note about it does not',
  () => {
    const turns: ConversationTurn[] = [
      {
        role: 'customer',
        parts: [
          { type: 'text', text: '[The customer sent a photo. What it shows:]' },
          { type: 'text', text: 'A cracked screen on a phone.' },
        ],
      },
    ];
    const corpus = [
      'The customer sent us a photo of the shop and it shows nicely in the window.',
      'Screen repairs for a cracked phone are finished the same afternoon.',
      'Opening hours are nine to six on weekdays.',
    ];
    assert.deepEqual(contentsOf(selectKnowledge(knowledge(corpus), turns, 70)), [corpus[1]]);
  },
);

unitTest('older turns count for less than the message being answered', () => {
  const corpus = ['Parking is free behind the building.', 'Refunds are issued within fourteen days.'];
  const turns: ConversationTurn[] = [
    { role: 'customer', parts: [{ type: 'text', text: 'is parking free?' }] },
    { role: 'bot', text: 'Yes.' },
    { role: 'customer', parts: [{ type: 'text', text: 'and refunds?' }] },
  ];
  assert.deepEqual(contentsOf(selectKnowledge(knowledge(corpus), turns, 45)), [corpus[1]]);
});

unitTest('only the latest turns are ranked against, so an old topic does not hold its place forever', () => {
  const corpus = ['Parking is free behind the building.', 'Opening hours are nine to six.'];
  const old: ConversationTurn[] = [];
  old.push({ role: 'customer', parts: [{ type: 'text', text: 'parking parking parking' }] }, { role: 'bot', text: 'Yes.' });
  for (let i = 0; i < KNOWLEDGE_SELECTION.queryTurns; i += 1) {
    old.push({ role: 'customer', parts: [{ type: 'text', text: 'zzz' }] });
  }
  // Room for either entry but not both. Nothing recent matches, so configured order
  // decides; parking winning would be the old question still being counted.
  assert.deepEqual(contentsOf(selectKnowledge(knowledge([corpus[1]!, corpus[0]!]), old, 36)), [corpus[1]]);
});

specTest(
  SPEC,
  'AC6 a configured fact reaches the reply that answers about it',
  'a message matching nothing still fills the budget, oldest entries first, rather than leaving the model with no facts',
  () => {
    for (const message of ['👍', '...', '']) {
      const turns: ConversationTurn[] = message === '' ? [{ role: 'customer', parts: [{ type: 'text', text: '[The customer sent an empty message.]' }] }] : asked(message);
      const selection = selectKnowledge(knowledge(SHOP), turns, TIGHT);
      assert.equal(selection.entries[0]!.content, SHOP[0]);
      assert.ok(sizeOf(selection) > TIGHT / 2, 'the budget is used');
      assert.ok(selection.partial);
    }
  },
);

unitTest('ranking is deterministic, and ties go to the older entry', () => {
  const corpus = ['delivery one', 'delivery two', 'delivery six'];
  for (let i = 0; i < 5; i += 1) {
    assert.deepEqual(contentsOf(selectKnowledge(knowledge(corpus), asked('delivery'), 12)), [corpus[0]]);
  }
});

unitTest('an entry with no words at all is ranked without breaking anything', () => {
  const corpus = ['🎉🎉🎉', 'Delivery is free.'];
  assert.deepEqual(contentsOf(selectKnowledge(knowledge(corpus), asked('delivery'), 17)), [corpus[1]]);
  assert.deepEqual(contentsOf(selectKnowledge(knowledge(['🎉🎉', '🎊🎊']), asked('delivery'), 3)), ['🎉🎉']);
});

specTest(
  SPEC,
  'AC6 a configured fact reaches the reply that answers about it',
  'a selection tells the model it is one, so a fact left out is not read as a fact denied',
  () => {
    const text = knowledgeDirectives(selectKnowledge(knowledge(SHOP), asked('do you deliver?'), TIGHT))!;
    assert.match(text, /only the facts most relevant to this conversation/);
    assert.match(text, /do not guess and do not say the business lacks it/);
    assert.match(text, /"fallback" action with low_confidence/);
    assert.ok(text.includes(JSON.stringify(SHOP[1])), 'entries are framed by the one renderer, JSON-quoted');
  },
);
