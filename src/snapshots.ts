import { randomUUID } from "crypto";
import * as path from "path";
import * as vscode from "vscode";

export const BEFORE_SCHEME = "agentdev-before";

/**
 * Contenus d'un fichier avant une modification de l'agent. Le diff natif de
 * l'éditeur les lit par une URI virtuelle : rien n'est écrit sur le disque.
 */
class BeforeStore implements vscode.TextDocumentContentProvider {
  private docs = new Map<string, string>();

  uriFor(file: string, content: string): vscode.Uri {
    const key = randomUUID();
    this.docs.set(key, content);
    return vscode.Uri.from({ scheme: BEFORE_SCHEME, path: `/${path.basename(file)}`, query: key });
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.docs.get(uri.query) ?? "";
  }
}

export const beforeStore = new BeforeStore();
