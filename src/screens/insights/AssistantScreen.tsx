import React, { useEffect, useRef, useState } from 'react';
import { FlatList, Pressable, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { assistantExamples, type AssistantProvider, type AssistantReply } from '../../domain/assistant/engine';
import type { RootScreenProps } from '../../navigation/types';
import { createAssistant } from '../../services/assistantData';
import { useCtx, useAppStore } from '../../state/appStore';
import { Card, Chip, ChipScroller, Icon, Row, Screen, Txt } from '../../ui/components/primitives';
import { radius, toneColor, useTheme } from '../../ui/theme';

interface Message {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  reply?: AssistantReply;
}

let seq = 0;

export function AssistantScreen({ navigation, route }: RootScreenProps<'Assistant'>) {
  const { c, t } = useTheme();
  const ctx = useCtx();
  const version = useAppStore((s) => s.dataVersion);
  const insets = useSafeAreaInsets();
  const [messages, setMessages] = useState<Message[]>([
    {
      id: ++seq,
      role: 'assistant',
      text: "Hi! I'm Finora's offline financial assistant. I answer questions using only the records on this phone — nothing is sent anywhere. What would you like to know?",
    },
  ]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const provider = useRef<AssistantProvider | null>(null);
  const list = useRef<FlatList<Message>>(null);

  useEffect(() => {
    provider.current = null; // data changed → rebuild data source lazily
  }, [version]);

  const ask = async (q: string) => {
    const question = q.trim();
    if (!question || busy) return;
    setText('');
    setMessages((m) => [...m, { id: ++seq, role: 'user', text: question }]);
    setBusy(true);
    try {
      if (!provider.current) provider.current = await createAssistant(ctx);
      const reply = await provider.current.answer(question);
      setMessages((m) => [...m, { id: ++seq, role: 'assistant', text: reply.text, reply }]);
    } catch (e) {
      setMessages((m) => [...m, { id: ++seq, role: 'assistant', text: 'Sorry, something went wrong while calculating that.' }]);
    } finally {
      setBusy(false);
      setTimeout(() => list.current?.scrollToEnd({ animated: true }), 80);
    }
  };

  useEffect(() => {
    if (route.params?.q) void ask(route.params.q);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.params?.q]);

  const render = ({ item }: { item: Message }) => {
    const mine = item.role === 'user';
    const r = item.reply;
    return (
      <View style={{ alignItems: mine ? 'flex-end' : 'flex-start', marginBottom: 10 }}>
        <View
          style={{
            maxWidth: '88%',
            padding: 14,
            borderRadius: radius.lg,
            borderTopRightRadius: mine ? 6 : radius.lg,
            borderTopLeftRadius: mine ? radius.lg : 6,
            backgroundColor: mine ? c.primary : c.mode === 'dark' ? c.glass : c.surface,
            borderWidth: mine ? 0 : 1,
            borderColor: r && r.tone !== 'neutral' ? toneColor(c, r.tone) + '66' : c.glassBorder,
          }}
          accessible
          accessibilityLabel={`${mine ? 'You' : 'Finora'}: ${item.text}`}
        >
          <Txt v="body" color={mine ? c.onPrimary : undefined}>
            {item.text}
          </Txt>
          {r?.items.length ? (
            <View style={{ marginTop: 10, gap: 6 }}>
              {r.items.map((it, i) => (
                <Row key={i} justify="space-between" align="flex-start" gap={10}>
                  <View style={{ flex: 1 }}>
                    <Txt v="small" numberOfLines={2}>
                      {it.label}
                    </Txt>
                    {it.sub ? (
                      <Txt v="caption" faint numberOfLines={2}>
                        {it.sub}
                      </Txt>
                    ) : null}
                  </View>
                  <Txt v="small" style={{ fontWeight: '700' }}>
                    {it.value}
                  </Txt>
                </Row>
              ))}
            </View>
          ) : null}
          {r?.steps.length ? (
            <View style={{ marginTop: 10, padding: 10, borderRadius: 10, backgroundColor: c.inputBg }}>
              <Txt v="label" faint style={{ marginBottom: 4 }}>
                How I calculated this
              </Txt>
              {r.steps.map((s, i) => (
                <Txt key={i} v="caption" dim>
                  {s}
                </Txt>
              ))}
            </View>
          ) : null}
          {r?.suggestions.length ? (
            <View style={{ marginTop: 10, gap: 6 }}>
              {r.suggestions.map((s) => (
                <Pressable key={s} onPress={() => ask(s)} accessibilityRole="button" style={{ paddingVertical: 8, paddingHorizontal: 12, borderRadius: 12, backgroundColor: c.primarySoft }}>
                  <Txt v="small" color={c.primary}>
                    {s}
                  </Txt>
                </Pressable>
              ))}
            </View>
          ) : null}
        </View>
      </View>
    );
  };

  return (
    <Screen title="Financial assistant" subtitle="Rule-based · private · works offline" onBack={() => navigation.goBack()} scroll={false} padded={false}>
      <FlatList
        ref={list}
        data={messages}
        keyExtractor={(m) => String(m.id)}
        renderItem={render}
        contentContainerStyle={{ padding: 16, paddingBottom: 24 }}
        onContentSizeChange={() => list.current?.scrollToEnd({ animated: true })}
        ListFooterComponent={
          busy ? (
            <Txt v="small" dim>
              Calculating…
            </Txt>
          ) : messages.length === 1 ? (
            <Card>
              <Txt v="label" dim style={{ marginBottom: 8 }}>
                Try asking
              </Txt>
              {assistantExamples().map((e) => (
                <Pressable key={e} onPress={() => ask(e)} accessibilityRole="button" style={{ paddingVertical: 8 }}>
                  <Row gap={8}>
                    <Icon name="chatbubble-ellipses-outline" size={16} color={c.primary} />
                    <Txt v="small" color={c.primary} style={{ flex: 1 }}>
                      {e}
                    </Txt>
                  </Row>
                </Pressable>
              ))}
            </Card>
          ) : null
        }
      />
      <View style={{ paddingHorizontal: 12, paddingTop: 8, paddingBottom: Math.max(insets.bottom, 10), borderTopWidth: 1, borderTopColor: c.border, backgroundColor: c.bg }}>
        {messages.length > 1 ? (
          <ChipScroller>
            {assistantExamples()
              .slice(0, 6)
              .map((e) => (
                <Chip key={e} label={e} onPress={() => ask(e)} />
              ))}
          </ChipScroller>
        ) : null}
        <Row gap={8} style={{ marginTop: 8 }}>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder="Ask about your money…"
            placeholderTextColor={c.textFaint}
            style={[t.body, { flex: 1, color: c.text, backgroundColor: c.inputBg, borderRadius: 16, paddingHorizontal: 16, minHeight: 48, borderWidth: 1, borderColor: c.border }]}
            onSubmitEditing={() => ask(text)}
            returnKeyType="send"
            maxLength={500}
            accessibilityLabel="Question for the assistant"
          />
          <Pressable
            onPress={() => ask(text)}
            accessibilityRole="button"
            accessibilityLabel="Send"
            disabled={!text.trim() || busy}
            style={{ width: 48, height: 48, borderRadius: 16, backgroundColor: text.trim() ? c.primary : c.surfaceAlt, alignItems: 'center', justifyContent: 'center' }}
          >
            <Icon name="send" size={20} color={text.trim() ? c.onPrimary : c.textFaint} />
          </Pressable>
        </Row>
      </View>
    </Screen>
  );
}
