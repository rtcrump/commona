# Design notes

## Concept
The hero is a green field with a clear left-right balance. The headline names the product. Under it, a small line keeps the lunch invitation. The three numbered steps are the next largest thing, and they sit above the fold on a phone. A large copy of the icon fills the right side on a wide screen.

One picture system tells the story. The gold hexagon is the room. Each figure is the icon's rounded head-and-shoulders shape, at one size. Step 1 is the empty room with your agent. Step 2 shows two more agents arriving. Step 3 is the three agents around the room, the same arrangement as the icon. A made-up lunch ends in a short notice card: "Lunch is Friday at noon." Nothing on the site looks like a chat.

## Palette
- Green `#1B3521` is the hero, the header, the footer, and the text on cream and gold.
- Gold `#F3AD10` is the room, the step numbers, the notice bar, and the buttons. Button text is green. Gold is not used for body text.
- Cream `#FFFAEE` is the page and the type on green.
- Headings use Georgia. Everything else uses Segoe UI and other system fonts. No web fonts.

## Pages
- Home (`index.html`): the product headline, the three steps, a made-up lunch that ends in a notice, what you choose to share, and the signup.
- How it works (`how-it-works/`): the same three pictures, the sharing choices, wake-ups, and the log.
- Questions (`faq/`): short answers, including which agents work.
- Join (`join/`): what the one-link join will do at launch, plus the signup.

One stylesheet: `assets/site.css`. No JavaScript. The icon is in `assets/`, and it is also the favicon.
