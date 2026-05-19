import { Question, type Attachment } from '../src/client/schema';

describe('Attachment schema (TDD §6.1)', () => {
  test('Attachment object round-trips through Question.toDict / fromDict', () => {
    const att: Attachment = {
      attachment_id: '11111111-1111-1111-1111-111111111111',
      mime: 'application/pdf',
      filename: 'report.pdf',
      size_bytes: 482113,
      path: '.chats/22222222-2222-2222-2222-222222222222/11111111-1111-1111-1111-111111111111.pdf',
    };
    const q = new Question({});
    q.attachments = [att];
    const round = Question.fromDict(q.toDict());
    expect(round.attachments).toEqual([att]);
  });

  test('Question.attachments defaults to []', () => {
    const q = new Question({});
    expect(q.attachments).toEqual([]);
    const round = Question.fromDict(q.toDict());
    expect(round.attachments).toEqual([]);
  });

  test('QuestionHistory.attachments round-trips when present and is absent when omitted', () => {
    const q = new Question({});
    q.history.push({ role: 'user', content: 'first', attachments: [{
      attachment_id: '33333333-3333-3333-3333-333333333333',
      mime: 'image/png',
      filename: 'shot.png',
      size_bytes: 12345,
      path: '.chats/22222222-2222-2222-2222-222222222222/33333333-3333-3333-3333-333333333333.png',
    }] });
    q.history.push({ role: 'assistant', content: 'second' });
    const round = Question.fromDict(q.toDict());
    expect(round.history[0].attachments).toHaveLength(1);
    expect(round.history[1].attachments).toBeUndefined();
  });
});
