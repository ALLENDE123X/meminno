import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-8">
      <Card className="max-w-lg w-full">
        <CardHeader>
          <CardTitle>Meminno</CardTitle>
          <CardDescription>
            Upload or paste your coursework. Get AI-generated notes, flashcards, and a quiz — plus a
            shareable weekly progress stat card.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button>Get started</Button>
        </CardContent>
      </Card>
    </main>
  );
}
