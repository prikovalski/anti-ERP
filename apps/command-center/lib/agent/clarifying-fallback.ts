export function buildClarifyingFallbackQuestion(message: string | undefined | null) {
  const normalized = normalizeText(message ?? "");

  if (!normalized) {
    return "O que voce quer fazer agora? Posso criar um pedido, emitir uma nota fiscal, cadastrar algo, movimentar estoque ou gerar um relatorio.";
  }

  if (mentionsSalesOrder(normalized)) {
    if (!mentionsCustomer(normalized) && !mentionsProductOrItem(normalized)) {
      return "Voce quer criar ou alterar um pedido? Me diga o cliente e os itens, por exemplo: criar pedido para Maria com 2 monitores.";
    }
    if (!mentionsCustomer(normalized)) {
      return "Para qual cliente devo criar ou alterar esse pedido?";
    }
    if (!mentionsProductOrItem(normalized)) {
      return "Quais itens e quantidades devo colocar no pedido?";
    }
    return "Entendi que isso envolve pedido, mas faltou um detalhe. Voce quer criar, alterar, cancelar, consultar ou duplicar o pedido?";
  }

  if (mentionsInvoice(normalized)) {
    if (!/\b(so|pedido)\s*-?\s*\d+\b/.test(normalized) && !/\b(ultimo|criado|atual|esse|este)\b/.test(normalized)) {
      return "Qual pedido devo usar para emitir, consultar, cancelar ou reemitir a nota fiscal?";
    }
    return "O que voce quer fazer com a nota fiscal desse pedido: emitir, consultar, cancelar ou reemitir?";
  }

  if (mentionsCatalog(normalized)) {
    if (!/\b(cliente|produto|fornecedor)\b/.test(normalized)) {
      return "Voce quer trabalhar com cliente, produto ou fornecedor?";
    }
    if (!/\b(cadastre|cadastrar|crie|criar|registre|adicionar|adicione|atualize|alterar|altere|renomeie|listar|liste|buscar|busque)\b/.test(normalized)) {
      return "O que devo fazer nesse cadastro: criar, atualizar, listar, buscar, ativar ou inativar?";
    }
    return "Qual nome devo usar nesse cadastro?";
  }

  if (mentionsInventory(normalized)) {
    if (!mentionsProductOrItem(normalized)) {
      return "Qual produto devo movimentar no estoque?";
    }
    if (!/\b\d+\b/.test(normalized) && !/\b(um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez)\b/.test(normalized)) {
      return "Qual quantidade devo usar nessa movimentacao de estoque?";
    }
    return "No estoque, voce quer entrada, saida, ajuste, reserva, liberacao de reserva ou historico?";
  }

  if (mentionsReport(normalized)) {
    return "Que relatorio voce quer ver? Posso responder sobre vendas por periodo, faturamento, produto mais vendido, clientes ativos, margem, estoque baixo ou tendencias.";
  }

  return "Ainda nao consegui ligar sua mensagem a uma acao. Voce quer criar um pedido, emitir uma nota, cadastrar algo, movimentar estoque ou gerar um relatorio?";
}

function mentionsSalesOrder(normalized: string) {
  return /\b(pedido|pedidos|venda|vendas|orcamento|orcamentos)\b/.test(normalized);
}

function mentionsInvoice(normalized: string) {
  return /\b(nf|nota|fiscal|faturar|fature|emissao|emitir|emita|reemitir|reemitir)\b/.test(normalized);
}

function mentionsCatalog(normalized: string) {
  return /\b(cadastro|cadastre|cadastrar|cliente|clientes|produto|produtos|fornecedor|fornecedores|registre|registrar|inativar|ativar)\b/.test(normalized);
}

function mentionsInventory(normalized: string) {
  return /\b(estoque|entrada|saida|ajuste|ajustar|reserva|reservar|liberar|baixa|baixar|movimentacao|movimentacoes)\b/.test(normalized);
}

function mentionsReport(normalized: string) {
  return /\b(relatorio|relatorios|dashboard|indicador|indicadores|faturamento|receita|margem|ranking|tendencia|tendencias|vendidos|vendas)\b/.test(normalized);
}

function mentionsCustomer(normalized: string) {
  return /\b(cliente|para|pra|p\/|comprador)\b/.test(normalized);
}

function mentionsProductOrItem(normalized: string) {
  return /\b(produto|produtos|item|itens|monitor|monitores|notebook|notebooks|mouse|teclado|unidade|unidades)\b/.test(normalized);
}

function normalizeText(value: string) {
  return value
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}
