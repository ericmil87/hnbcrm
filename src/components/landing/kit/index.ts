/**
 * Kit de cena: peças de apresentação (sem Convex) para as cenas da landing e
 * para o chat do onboarding. Regras de movimento: só transform/opacity, nada
 * anima com movimento reduzido, cenas em loop têm botão de pausa.
 */
export { ChatWindow, AiAvatar, type ChatWindowProps } from "./ChatWindow";
export { Bubble, type BubbleProps, type BubbleVariant, type BubbleSide, type BubbleTicks } from "./Bubble";
export { TypingDots, type TypingDotsProps } from "./TypingDots";
export { AudioBubble, type AudioBubbleProps } from "./AudioBubble";
export { AttachmentBubble, type AttachmentBubbleProps, type AttachmentKind } from "./AttachmentBubble";
export { Composer, type ComposerProps } from "./Composer";
export { RotatingPlaceholder, type RotatingPlaceholderProps } from "./RotatingPlaceholder";
export { ChipRow, type Chip, type ChipRowProps } from "./ChipRow";
export {
  MiniFunnel,
  type MiniFunnelProps,
  type MiniFunnelColumn,
  type MiniFunnelCard,
  type MiniFunnelMovingCard,
} from "./MiniFunnel";
export { PhoneNotification, type PhoneNotificationProps, type PhoneNotificationAction } from "./PhoneNotification";
export { ChatFeed, type ChatFeedProps } from "./ChatFeed";
export {
  FunnelRail,
  type FunnelRailProps,
  type FunnelRailStage,
  type FunnelRailCard,
  type FunnelRailMovingCard,
  type FunnelRailOrientation,
} from "./FunnelRail";
export { PhoneFrame, type PhoneFrameProps } from "./PhoneFrame";
export { SceneSteps, type SceneStepsProps, type SceneStepsItem } from "./SceneSteps";
export { SceneLoop, ScenePauseButton, type SceneLoopProps, type SceneLoopState, type ScenePauseButtonProps } from "./SceneLoop";
export { useSceneTimeline, type SceneStep, type SceneTimeline, type SceneTimelineOptions } from "./useSceneTimeline";
