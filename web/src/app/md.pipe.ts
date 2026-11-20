import { Pipe, PipeTransform } from '@angular/core';
import { marked } from 'marked';

/**
 * Markdown to HTML, for text that arrives raw (Lumos's comments, Claude's prompts and replies) rather than
 * already rendered by GitHub. Bind the result with [innerHTML], which runs Angular's sanitizer over it.
 * HTML comments are dropped first: Lumos tags its comments with a hidden marker.
 */
@Pipe({ name: 'md' })
export class MdPipe implements PipeTransform {
  transform(src: string | null | undefined): string {
    if (!src) return '';
    return marked.parse(src.replace(/<!--[\s\S]*?-->\s*/g, ''), { async: false, gfm: true, breaks: true });
  }
}
