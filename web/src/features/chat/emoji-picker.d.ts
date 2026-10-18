// JSX typing for the <emoji-picker> web component from emoji-picker-element.
import type { DetailedHTMLProps, HTMLAttributes } from 'react';
import type Picker from 'emoji-picker-element/picker';

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'emoji-picker': DetailedHTMLProps<HTMLAttributes<Picker>, Picker> & { class?: string };
    }
  }
}
