# Локальные шрифты

Marcellus — латинские заголовки, Cormorant Garamond — кириллические,
Lora — основной текст и курсив. Подмножества: латиница и кириллица.

Обновление из `app`: `node scripts/fetch-fonts.mjs`. Обычная сборка не обращается
к Google Fonts. Одинаковые бинарные файлы разных начертаний сохраняются один раз;
CSS может использовать один файл для нескольких весов. Vite включает ресурсы
в `dist/assets`, не создавая второй копии в `public/fonts`.

Лицензии поставляются вместе с приложением в `public/licenses`:

- [Marcellus](../../../public/licenses/Marcellus-OFL.txt)
- [Lora](../../../public/licenses/Lora-OFL.txt)
- [Cormorant Garamond](../../../public/licenses/CormorantGaramond-OFL.txt)

Источник: каталоги `ofl/marcellus`, `ofl/lora`, `ofl/cormorantgaramond`
в [google/fonts](https://github.com/google/fonts/tree/main/ofl).
