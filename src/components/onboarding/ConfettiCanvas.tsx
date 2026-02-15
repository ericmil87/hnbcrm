import { useEffect, useRef } from "react";

interface ConfettiCanvasProps {
  active: boolean;
  duration?: number;
  onComplete?: () => void;
}

interface Particle {
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  rotation: number;
  rotationSpeed: number;
  velocityX: number;
  velocityY: number;
  gravity: number;
  wind: number;
  opacity: number;
}

const COLORS = [
  "#FF6B00",
  "#FB923C",
  "#FED7AA",
  "#10B981",
  "#3B82F6",
  "#8B5CF6",
  "#EC4899",
];

function random(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

function createParticle(canvasWidth: number, canvasHeight: number): Particle {
  const centerX = canvasWidth / 2;
  const topY = canvasHeight * 0.1;

  return {
    x: centerX + random(-50, 50),
    y: topY,
    width: random(8, 12),
    height: random(6, 8),
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
    rotation: random(0, Math.PI * 2),
    rotationSpeed: random(-0.1, 0.1),
    velocityX: random(-8, 8),
    velocityY: random(-15, -8),
    gravity: random(0.3, 0.5),
    wind: random(-0.1, 0.1),
    opacity: 1,
  };
}

export function ConfettiCanvas({
  active,
  duration = 3000,
  onComplete,
}: ConfettiCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const particlesRef = useRef<Particle[]>([]);
  const animationFrameRef = useRef<number>();
  const startTimeRef = useRef<number>();

  useEffect(() => {
    if (!active) {
      return;
    }

    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }

    // Set canvas size
    const resizeCanvas = () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
    };
    resizeCanvas();
    window.addEventListener("resize", resizeCanvas);

    // Create particles
    particlesRef.current = Array.from({ length: 150 }, () =>
      createParticle(canvas.width, canvas.height)
    );

    startTimeRef.current = performance.now();

    const animate = (currentTime: number) => {
      if (!startTimeRef.current) {
        return;
      }

      const elapsed = currentTime - startTimeRef.current;
      const progress = Math.min(elapsed / duration, 1);

      // Clear canvas
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      // Update and draw particles
      particlesRef.current.forEach((particle) => {
        // Update physics
        particle.velocityY += particle.gravity;
        particle.velocityX += particle.wind;
        particle.x += particle.velocityX;
        particle.y += particle.velocityY;
        particle.rotation += particle.rotationSpeed;

        // Fade out in last 500ms
        if (elapsed > duration - 500) {
          const fadeProgress = (elapsed - (duration - 500)) / 500;
          particle.opacity = 1 - fadeProgress;
        }

        // Draw particle
        ctx.save();
        ctx.translate(particle.x, particle.y);
        ctx.rotate(particle.rotation);
        ctx.globalAlpha = particle.opacity;
        ctx.fillStyle = particle.color;
        ctx.fillRect(
          -particle.width / 2,
          -particle.height / 2,
          particle.width,
          particle.height
        );
        ctx.restore();
      });

      if (progress < 1) {
        animationFrameRef.current = requestAnimationFrame(animate);
      } else {
        // Animation complete
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        onComplete?.();
      }
    };

    animationFrameRef.current = requestAnimationFrame(animate);

    return () => {
      window.removeEventListener("resize", resizeCanvas);
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [active, duration, onComplete]);

  if (!active) {
    return null;
  }

  return (
    <canvas
      ref={canvasRef}
      className="fixed inset-0 z-50 pointer-events-none"
      aria-hidden="true"
    />
  );
}
