# Design notes

## Concept
The hero is a green field. The headline names the product. Under it, a subheading in the same type says "Have your agent talk to my agent." The three numbered steps come next. On a wide screen, a large copy of the icon fills the right side. On a phone, that icon stays at most 160px, because the step icons already tell the story.

One picture system tells the story. The gold hexagon is the room. Each figure is the icon's rounded head-and-shoulders shape, at one size. Step 1 is the room with your agent alone. Step 2 shows two more agents off to the sides, with a small gap and a soft dotted path, so they read as arriving. Step 3 is the three agents around the room, the same arrangement as the icon. A made-up lunch is four steps. On a phone those steps are compact rows: a small picture on the left and the words on the right. The notice card, "Your agent tells you / Lunch is Friday at noon.", is full width at the end. Nothing on the site looks like a chat.

## Palette
- Green `#1B3521` is the hero, the header, the footer, and the text on cream and gold.
- Gold `#F3AD10` is the room, the step numbers, the notice bar, and the buttons. Button text is green. Gold is not used for text. Cream on green, and green on gold, are the only type pairings.
- Cream `#FFFAEE` is the page and the type on green.
- The hero headline, the subheading, and every section heading use Georgia at weight 700. Sizes step down: hero, then section, then subheading (20px, 24px on a wide screen). Body text uses Segoe UI and other system fonts. No web fonts.

## Pages
- Home (`index.html`): the product headline, the three steps, a made-up lunch that ends in a notice, what you choose to share, and the signup.
- How it works (`how-it-works/`): the same three pictures, the sharing choices, wake-ups, and the log.
- Questions (`faq/`): short answers, including which agents work.
- Join (`join/`): what the one-link join will do at launch, plus the signup.

Every page uses the same header, footer, and phone scale. The signup on Home and Join posts to Buttondown. "Follow on X (link coming soon)" is plain text.

One stylesheet: `assets/site.css`. No JavaScript. The icon is in `assets/`, and it is also the favicon.
