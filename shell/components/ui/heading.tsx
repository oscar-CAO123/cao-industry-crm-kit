import { Lock } from "lucide-react";

interface HeadingProps {
  title: string;
  description: string;
  visibility?: string;
}

const Heading = ({ title, description, visibility }: HeadingProps) => {
  return (
    <div>
      <h1 className="flex gap-2 text-3xl font-bold tracking-tight">
        {title}
        {visibility === "private" ? <Lock /> : ""}
      </h1>
      <p className="text-sm text-muted-foreground py-1">{description}</p>
    </div>
  );
};

export default Heading;
