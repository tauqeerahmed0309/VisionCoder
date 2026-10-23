from __future__ import annotations

from typing import Annotated, Literal, Union

from pydantic import BaseModel, ConfigDict, Field, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


ComponentId = Annotated[str, Field(pattern=r"^[A-Za-z0-9_-]{1,80}$")]
ShortText = Annotated[str, Field(min_length=1, max_length=150)]


class NavbarProps(StrictModel):
    brand: Annotated[str, Field(min_length=1, max_length=60)]
    links: Annotated[list[Annotated[str, Field(min_length=1, max_length=40)]], Field(max_length=6)]
    ctaLabel: Annotated[str, Field(max_length=40)] = ""


class HeroProps(StrictModel):
    eyebrow: Annotated[str, Field(max_length=80)] = ""
    heading: Annotated[str, Field(min_length=1, max_length=150)]
    body: Annotated[str, Field(max_length=500)]
    # An empty label means the sketch has no hero button.
    buttonLabel: Annotated[str, Field(max_length=60)]
    alignment: Literal["left", "center", "right"]


class TextSectionProps(StrictModel):
    heading: Annotated[str, Field(min_length=1, max_length=150)]
    body: Annotated[str, Field(max_length=1000)]


class ImagePlaceholderProps(StrictModel):
    label: Annotated[str, Field(min_length=1, max_length=100)]
    aspectRatio: Literal["wide", "square"]


class ButtonProps(StrictModel):
    label: Annotated[str, Field(min_length=1, max_length=60)]
    action: Literal["none", "scroll_to_section"]
    targetId: ComponentId | None = None

    @model_validator(mode="after")
    def validate_target(self) -> "ButtonProps":
        if self.action == "scroll_to_section" and not self.targetId:
            raise ValueError("targetId is required when action is scroll_to_section")
        if self.action == "none" and self.targetId is not None:
            raise ValueError("targetId must be null when action is none")
        return self


class CardItem(StrictModel):
    id: ComponentId
    title: Annotated[str, Field(min_length=1, max_length=100)]
    body: Annotated[str, Field(max_length=500)]


class CardGridProps(StrictModel):
    heading: Annotated[str, Field(max_length=150)] = ""
    cards: Annotated[list[CardItem], Field(min_length=1, max_length=6)]


class FooterProps(StrictModel):
    text: Annotated[str, Field(max_length=200)]
    links: Annotated[list[Annotated[str, Field(min_length=1, max_length=40)]], Field(max_length=6)]


class NavbarComponent(StrictModel):
    id: ComponentId
    type: Literal["navbar"]
    props: NavbarProps


class HeroComponent(StrictModel):
    id: ComponentId
    type: Literal["hero"]
    props: HeroProps


class TextSectionComponent(StrictModel):
    id: ComponentId
    type: Literal["textSection"]
    props: TextSectionProps


class ImagePlaceholderComponent(StrictModel):
    id: ComponentId
    type: Literal["imagePlaceholder"]
    props: ImagePlaceholderProps


class ButtonComponent(StrictModel):
    id: ComponentId
    type: Literal["button"]
    props: ButtonProps


class CardGridComponent(StrictModel):
    id: ComponentId
    type: Literal["cardGrid"]
    props: CardGridProps


class FooterComponent(StrictModel):
    id: ComponentId
    type: Literal["footer"]
    props: FooterProps


Component = Annotated[
    Union[
        NavbarComponent,
        HeroComponent,
        TextSectionComponent,
        ImagePlaceholderComponent,
        ButtonComponent,
        CardGridComponent,
        FooterComponent,
    ],
    Field(discriminator="type"),
]


class DetectedElement(StrictModel):
    label: Annotated[str, Field(min_length=1, max_length=100)]
    componentId: ComponentId | None = None


class PageSpec(StrictModel):
    schemaVersion: Literal["1.0"]
    pageTitle: Annotated[str, Field(min_length=1, max_length=100)]
    themeHint: Literal["professional", "minimalist", "colorful"]
    components: Annotated[list[Component], Field(min_length=1, max_length=20)]
    detectedElements: list[DetectedElement]
    uncertainties: list[Annotated[str, Field(max_length=250)]]

    @model_validator(mode="after")
    def validate_ids_and_references(self) -> "PageSpec":
        ids: list[str] = []
        for component in self.components:
            ids.append(component.id)
            if component.type == "cardGrid":
                ids.extend(card.id for card in component.props.cards)

        if len(ids) != len(set(ids)):
            raise ValueError("Every component and card must have a unique ID")

        known_component_ids = {component.id for component in self.components}
        for component in self.components:
            if component.type == "button" and component.props.action == "scroll_to_section":
                if component.props.targetId not in known_component_ids:
                    raise ValueError("button targetId must reference an existing component ID")

        for detected in self.detectedElements:
            if detected.componentId is not None and detected.componentId not in known_component_ids:
                raise ValueError("detectedElements componentId must reference an existing component ID")

        return self
