import { ModelProvider } from './model.js';
import { ModelCallError, ReviewError } from './review.type.js';

// 고른 AI 가 실패하면 다른 AI 로 한 번만 다시 시도한다. 되돌아가지는 않는다.
// 넘기는 것: 로그인 풀림·사용량 소진·빈 응답·비정상 종료(ModelCallError 'failed'), 응답 형식 깨짐(파서의 ReviewError).
// 넘기지 않는 것: 제한 시간 초과 — PR 이 커서 넘은 경우가 대부분이라 다른 AI 도 같이 넘고, 실패까지 두 배를 기다린다.

export const PROVIDER_LABEL: Record<ModelProvider, string> = { codex: 'ChatGPT', claude: 'Claude' };

export const otherProvider = (provider: ModelProvider): ModelProvider => (provider === 'codex' ? 'claude' : 'codex');

export const shouldFallback = (error: unknown): boolean =>
  error instanceof ReviewError && !(error instanceof ModelCallError && error.kind === 'timeout');

const firstLine = (error: unknown): string => (error instanceof Error ? error.message : String(error)).split('\n')[0];

export interface FallbackOutcome<T> {
  result: T;
  used: ModelProvider;
  fellBack: boolean;
}

export const withFallback = async <T>({
  primary,
  enabled,
  attempt,
  onSwitch,
}: {
  primary: ModelProvider;
  enabled: boolean;
  attempt: (provider: ModelProvider) => Promise<T>;
  onSwitch?: (next: ModelProvider, error: unknown) => void;
}): Promise<FallbackOutcome<T>> => {
  try {
    return { result: await attempt(primary), used: primary, fellBack: false };
  } catch (error: unknown) {
    if (!enabled || !shouldFallback(error)) {
      throw error;
    }
    const next = otherProvider(primary);
    onSwitch?.(next, error);
    try {
      return { result: await attempt(next), used: next, fellBack: true };
    } catch (second: unknown) {
      throw new ReviewError(
        `${PROVIDER_LABEL[primary]} 실패: ${firstLine(error)}\n${PROVIDER_LABEL[next]} 로 다시 했지만 실패: ${firstLine(second)}`,
      );
    }
  }
};
